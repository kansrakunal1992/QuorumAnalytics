'use strict'
// lib/metrics.js
// Every number on the dashboard comes from here.
//
// Principles
//  * AGGREGATES ONLY. No query selects decision text, message content, notes,
//    insight text, or any other user-written field. Quorum stores those
//    encrypted; this dashboard never touches them.
//  * ISOLATION. Each metric is its own query wrapped in safe(). If a table or
//    column is missing in your database, that one panel shows an error and the
//    rest of the page still loads.
//  * One parameter contract for all queries: $1 excluded user ids, $2 excluded
//    device ids, $3 window in days, $4 timezone. Each query reads them through
//    the `p` CTE.

const { q } = require('./db')

const NIL = '00000000-0000-0000-0000-000000000000'
const TZ = process.env.DASHBOARD_TZ || 'Asia/Kolkata'
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 60) * 1000

// ── SQL building blocks ──────────────────────────────────────────────────────
// start_ts = midnight (in the dashboard timezone) of the first day in the window, so headline
// numbers and the day-by-day charts always add up. prev_ts = start of the equal-length window before it.
const P = `p0 as (select $1::uuid[] as uids, $2::text[] as dids, $3::int as days, $4::text as tz),
p as (
  select p0.*,
    ((now() at time zone p0.tz)::date - (p0.days - 1))::timestamp at time zone p0.tz     as start_ts,
    ((now() at time zone p0.tz)::date - (2 * p0.days - 1))::timestamp at time zone p0.tz as prev_ts
  from p0
)`
const since = col => `${col} >= p.start_ts`
const prevWindow = col => `${col} >= p.prev_ts and ${col} < p.start_ts`
// exclusion for tables with user_id + device_id
const exUD = a =>
  `not (coalesce(${a}.user_id, '${NIL}'::uuid) = any(p.uids)) and not (coalesce(${a}.device_id, '') = any(p.dids))`
// exclusion for tables with only a user id column
const exU = (a, col = 'user_id') => `not (coalesce(${a}.${col}, '${NIL}'::uuid) = any(p.uids))`
// last N calendar days in the dashboard timezone
const DAYS_CTE = `d as (
  select g::date as day from p,
  generate_series(((now() at time zone p.tz)::date - (p.days - 1))::timestamp,
                  (now() at time zone p.tz)::date::timestamp, interval '1 day') g
)`

// A "person" is user_id when known, else the user_id of another session from the
// same browser (device), else the device id. This avoids double counting someone
// who decided anonymously and later signed in. Sessions with no user and no device
// (functional-cookie consent declined) cannot be attributed and have actor = null.
const BASE = `with ${P},
dev as (
  select device_id, (array_agg(user_id))[1] as user_id
  from sessions where device_id is not null and user_id is not null
  group by device_id
),
s as (
  select x.id, x.created_at, x.status,
         coalesce(x.user_id::text, d.user_id::text, x.device_id) as actor,
         (x.user_id is not null or d.user_id is not null) as linked
  from sessions x cross join p
  left join dev d on d.device_id = x.device_id
  where ${exUD('x')}
)`

// ── Query catalogue ──────────────────────────────────────────────────────────
const QUERIES = {}

// Headline numbers: decisions, people, stickiness, vs previous period
QUERIES.overview = `${BASE},
act as (select actor, created_at from s where actor is not null),
f as (select actor, min(created_at) as first_at from act group by actor)
select
  (select count(*) from s)::int                                                  as sessions_total,
  (select count(*) from s, p where ${since('s.created_at')})::int                as sessions_period,
  (select count(*) from s, p where ${prevWindow('s.created_at')})::int           as sessions_prev,
  (select count(*) from s where status = 'completed')::int                       as sessions_completed,
  (select count(*) from f)::int                                                  as people_total,
  (select count(distinct actor) from act, p where ${since('act.created_at')})::int      as people_period,
  (select count(distinct actor) from act, p where ${prevWindow('act.created_at')})::int as people_prev,
  (select count(*) from f, p where ${since('f.first_at')})::int                  as people_new_period,
  (select count(*) from f, p where ${prevWindow('f.first_at')})::int             as people_new_prev,
  (select count(distinct actor) from act where created_at >= now() - interval '1 day')::int   as dau,
  (select count(distinct actor) from act where created_at >= now() - interval '7 days')::int  as wau,
  (select count(distinct actor) from act where created_at >= now() - interval '30 days')::int as mau,
  (select count(*) from s where actor is null)::int                              as sessions_unattributed,
  (select min(created_at) from s)                                                as first_session_at`

// Supabase auth signups
QUERIES.signups = `with ${P}
select
  count(*)::int                                                                   as total,
  count(*) filter (where ${since('u.created_at')})::int                           as period,
  count(*) filter (where ${prevWindow('u.created_at')})::int                      as prev,
  count(*) filter (where u.last_sign_in_at >= now() - interval '7 days')::int     as signed_in_7d,
  count(*) filter (where coalesce(u.raw_app_meta_data->>'provider', 'email') = 'google')::int  as google,
  count(*) filter (where coalesce(u.raw_app_meta_data->>'provider', 'email') <> 'google')::int as magic_link,
  count(*) filter (where ${since('u.created_at')} and coalesce(u.raw_app_meta_data->>'provider', 'email') = 'google')::int  as google_period,
  count(*) filter (where ${since('u.created_at')} and coalesce(u.raw_app_meta_data->>'provider', 'email') <> 'google')::int as magic_link_period
from auth.users u cross join p
where not (u.id = any(p.uids))`

// Day-by-day: decisions, active people, signups
QUERIES.daily = `${BASE},
${DAYS_CTE},
ss as (
  select (s.created_at at time zone p.tz)::date as day, count(*)::int as sessions, count(distinct actor)::int as people
  from s, p where ${since('s.created_at')} group by 1
),
su as (
  select (u.created_at at time zone p.tz)::date as day, count(*)::int as signups
  from auth.users u, p where ${since('u.created_at')} and not (u.id = any(p.uids)) group by 1
)
select d.day::text as day, coalesce(ss.sessions, 0) as sessions, coalesce(ss.people, 0) as people, coalesce(su.signups, 0) as signups
from d left join ss using (day) left join su using (day) order by 1`

// Day-by-day first-party events (landing, started, completed)
QUERIES.events_daily = `with ${P},
${DAYS_CTE},
e as (
  select (ev.created_at at time zone p.tz)::date as day,
    count(*) filter (where ev.event = 'landing_view')       as landing,
    count(*) filter (where ev.event = 'decision_started')   as started,
    count(*) filter (where ev.event = 'decision_completed') as completed
  from events ev cross join p
  where ${since('ev.created_at')} and ${exUD('ev')} group by 1
)
select d.day::text as day, coalesce(e.landing, 0)::int as landing, coalesce(e.started, 0)::int as started,
       coalesce(e.completed, 0)::int as completed
from d left join e using (day) order by 1`

// Front door: every tracked event, count + distinct people
QUERIES.events_funnel = `with ${P}
select ev.event, count(*)::int as n,
       count(distinct coalesce(ev.user_id::text, ev.device_id))::int as people
from events ev cross join p
where ${since('ev.created_at')} and ${exUD('ev')}
group by 1 order by 2 desc`

// Events split by their most useful property
QUERIES.events_breakdown = `with ${P}
select ev.event,
  coalesce(case ev.event
    when 'decision_completed'        then ev.props->>'path'
    when 'auth_completed'            then (ev.props->>'provider') ||
                                          case when ev.props->>'new_registration' = 'true' then ' (new)' else ' (returning)' end
    when 'auth_prompt_seen'          then ev.props->>'stage'
    when 'auth_started'              then ev.props->>'method'
    when 'install_prompt_seen'       then ev.props->>'platform'
    when 'install_prompt_accepted'   then ev.props->>'platform'
    when 'notification_opted_in'     then ev.props->>'channel'
    when 'notification_opened'       then ev.props->>'source'
    when 'notification_to_decision'  then ev.props->>'source'
    when 'mirror_viewed'             then ev.props->>'gate_state'
    when 'paid_conversion'           then ev.props->>'plan'
    when 'mirror_unlocked'           then ev.props->>'via'
    when 'gate_arm_assigned'         then ev.props->>'arm'
    when 'observation_seen'          then ev.props->>'kind'
  end, '(none)') as k,
  count(*)::int as n
from events ev cross join p
where ${since('ev.created_at')} and ${exUD('ev')}
  and ev.event in ('decision_completed','auth_completed','auth_prompt_seen','auth_started','install_prompt_seen',
                   'install_prompt_accepted','notification_opted_in','notification_opened','notification_to_decision',
                   'mirror_viewed','paid_conversion','mirror_unlocked','gate_arm_assigned','observation_seen')
group by 1, 2 order by 1, 3 desc`

// How much event history exists (events only started once Phase 0 shipped)
QUERIES.events_coverage = `select count(*)::int as n, min(created_at) as first_at, max(created_at) as last_at from events`

// Hero: where each chat-intake journey stopped (mutually exclusive, furthest stage)
QUERIES.journey = `with ${P},
ci as (
  select c.id, c.status, c.exchange_count, c.session_id
  from chat_intakes c cross join p
  where ${since('c.created_at')} and ${exUD('c')}
),
e as (
  select ci.*,
    (s.initial_instinct is not null and s.optimization_priority is not null) as chips,
    (s.quorum_prediction_generated_at is not null)                           as pred,
    exists (select 1 from examiner_responses er where er.session_id = ci.session_id) as examiner,
    coalesce(s.status = 'completed', false)                                  as done,
    exists (select 1 from synthesis_versions sv where sv.session_id = ci.session_id and sv.version = 0) as synth,
    (s.final_decision_locked_at is not null)                                 as locked
  from ci left join sessions s on s.id = ci.session_id
)
select
  count(*)::int                                                       as started,
  count(*) filter (where status = 'checkpointed')::int                as confirmed,
  count(*) filter (where pred)::int                                   as predicted,
  count(*) filter (where examiner)::int                               as quick_check,
  count(*) filter (where synth)::int                                  as synthesis,
  count(*) filter (where locked)::int                                 as locked,
  count(*) filter (where done and not synth)::int                     as skipped_council,
  count(*) filter (where status = 'abandoned')::int                   as abandoned,
  round(avg(exchange_count)::numeric, 1)                              as avg_exchanges,
  -- mutually exclusive: furthest stage reached
  count(*) filter (where locked)::int                                                                  as st8,
  count(*) filter (where not locked and synth)::int                                                    as st7,
  count(*) filter (where not locked and not synth and done)::int                                       as st6,
  count(*) filter (where not locked and not synth and not done and examiner)::int                      as st5,
  count(*) filter (where not locked and not synth and not done and not examiner and pred)::int         as st4,
  count(*) filter (where not locked and not synth and not done and not examiner and not pred and status = 'checkpointed')::int as st3,
  count(*) filter (where not locked and not synth and not done and not examiner and not pred and status <> 'checkpointed' and chips)::int as st2,
  count(*) filter (where not locked and not synth and not done and not examiner and not pred and status <> 'checkpointed' and not chips)::int as st1
from e`

// Retention: D1 -> D5 and the "3rd decision within 30 days" headline, split by identity
QUERIES.retention = `${BASE},
f as (select actor, bool_or(linked) as linked, min(created_at) as first_at from s where actor is not null group by actor),
n as (
  select f.actor, f.linked, f.first_at, count(*) as total,
    count(*) filter (where s.created_at <= f.first_at + interval '14 days') as d14,
    count(*) filter (where s.created_at <= f.first_at + interval '30 days') as d30
  from f join s on s.actor = f.actor group by f.actor, f.linked, f.first_at
)
select grp,
  count(*)::int                                                              as d1,
  count(*) filter (where total >= 2)::int                                    as d2,
  count(*) filter (where total >= 3)::int                                    as d3,
  count(*) filter (where total >= 4)::int                                    as d4,
  count(*) filter (where total >= 5)::int                                    as d5,
  count(*) filter (where first_at <= now() - interval '30 days')::int        as mature30,
  count(*) filter (where first_at <= now() - interval '30 days' and d30 >= 2)::int as mature30_d2,
  count(*) filter (where first_at <= now() - interval '30 days' and d30 >= 3)::int as mature30_d3,
  count(*) filter (where first_at <= now() - interval '14 days')::int        as mature14,
  count(*) filter (where first_at <= now() - interval '14 days' and d14 >= 2)::int as mature14_d2
from n, lateral (values ('all'), (case when linked then 'linked' else 'anonymous' end)) g(grp)
group by grp order by grp`

// Weekly cohorts: of people whose first decision was in week X, how many decided again in week X+n
QUERIES.cohorts = `${BASE},
f as (select actor, min(created_at) as first_at from s where actor is not null group by actor),
c as (select f.actor, date_trunc('week', f.first_at at time zone p.tz)::date as cohort from f, p),
w as (select distinct s.actor, date_trunc('week', s.created_at at time zone p.tz)::date as wk from s, p where s.actor is not null)
select c.cohort::text as cohort,
  count(*)::int as size,
  count(*) filter (where exists (select 1 from w where w.actor = c.actor and w.wk = c.cohort + 7))::int  as w1,
  count(*) filter (where exists (select 1 from w where w.actor = c.actor and w.wk = c.cohort + 14))::int as w2,
  count(*) filter (where exists (select 1 from w where w.actor = c.actor and w.wk = c.cohort + 21))::int as w3,
  count(*) filter (where exists (select 1 from w where w.actor = c.actor and w.wk = c.cohort + 28))::int as w4,
  ((date_trunc('week', now() at time zone p.tz)::date - c.cohort) / 7)::int as weeks_elapsed
from c, p
where c.cohort >= date_trunc('week', now() at time zone p.tz)::date - 63
group by c.cohort, p.tz order by 1`

// How many decisions each active person made in the window
QUERIES.depth = `${BASE},
a as (select actor, count(*) as n from s, p where actor is not null and ${since('s.created_at')} group by actor)
select case when n = 1 then '1' when n = 2 then '2' when n = 3 then '3' when n <= 5 then '4-5' else '6+' end as bucket,
       count(*)::int as people, sum(n)::int as decisions
from a group by 1 order by min(n)`

// Session mix in the window: depth x intake mode x register
QUERIES.modes = `${BASE}
select x.session_depth as depth, x.intake_mode as mode, x.register_mode as register, count(*)::int as n
from s join sessions x on x.id = s.id cross join p
where ${since('s.created_at')}
group by 1, 2, 3`

// Behaviour flags on sessions in the window
QUERIES.flags = `${BASE}
select count(*)::int                                          as sessions,
  count(x.final_decision_locked_at)::int                      as locked,
  count(*) filter (where x.is_shared is true)::int            as shared,
  count(x.commitment_captured_at)::int                        as committed,
  count(x.council_nudge_sent_at)::int                         as nudged,
  count(x.parent_session_id)::int                             as follow_ups,
  count(x.post_decision_confidence)::int                      as n_conf,
  round(avg(x.post_decision_confidence)::numeric, 2)          as avg_conf
from s join sessions x on x.id = s.id cross join p
where ${since('s.created_at')}`

// Which advisors are speaking (counts of messages by persona and role; content is never read)
QUERIES.personas = `${BASE}
select m.persona, m.role, count(*)::int as n
from messages m join s on s.id = m.session_id cross join p
where ${since('m.created_at')}
group by 1, 2 order by 3 desc`

// When people decide: weekday x hour in the dashboard timezone, last 90 days
QUERIES.heatmap = `${BASE}
select extract(isodow from s.created_at at time zone p.tz)::int as dow,
       extract(hour from s.created_at at time zone p.tz)::int   as hr,
       count(*)::int as n
from s cross join p
where s.created_at >= now() - interval '90 days'
group by 1, 2`

// Did the Council help? (outcomes people report after the fact)
QUERIES.outcomes = `${BASE}
select
  (select count(*) from outcomes o join s on s.id = o.session_id)::int                                   as total,
  (select count(*) from outcomes o join s on s.id = o.session_id, p where ${since('o.created_at')})::int as period,
  (select count(*) from outcomes o join s on s.id = o.session_id where o.council_helped = 'yes')::int       as yes,
  (select count(*) from outcomes o join s on s.id = o.session_id where o.council_helped = 'partially')::int as partially,
  (select count(*) from outcomes o join s on s.id = o.session_id where o.council_helped = 'no')::int        as no,
  (select count(*) from s where s.status = 'completed' and s.created_at < now() - interval '30 days')::int  as eligible,
  (select count(*) from s join outcomes o on o.session_id = s.id
     where s.status = 'completed' and s.created_at < now() - interval '30 days')::int                       as eligible_with_outcome`

// Paid access currently on the books (mirror_access)
QUERIES.access = `with ${P}
select m.access_type, coalesce(m.product_tier, '(none)') as tier,
  count(*)::int as total,
  count(*) filter (where m.access_type in ('lifetime','advisory') or m.expires_at is null or m.expires_at > now())::int as active,
  count(*) filter (where (m.access_type in ('lifetime','advisory') or m.expires_at is null or m.expires_at > now())
                     and m.founding_member is true)::int as founding_active
from mirror_access m cross join p
where ${exU('m')}
group by 1, 2 order by 3 desc`

// Guest one-time Decision Session payments (Razorpay orders)
QUERIES.guest_payments = `with ${P}
select d.status, count(*)::int as n, coalesce(sum(d.amount_inr), 0)::int as amount,
  count(*) filter (where ${since('coalesce(d.paid_at, d.created_at)')})::int as n_period,
  coalesce(sum(d.amount_inr) filter (where ${since('coalesce(d.paid_at, d.created_at)')}), 0)::int as amount_period
from decision_session_payments d cross join p
group by 1 order by 1`

QUERIES.guest_by_source = `select coalesce(utm_source, '(none)') as src,
  count(*)::int as orders, count(*) filter (where status = 'paid')::int as paid
from decision_session_payments group by 1 order by 3 desc, 2 desc limit 10`

// Where new signups came from
QUERIES.acq_utm = `with ${P}
select coalesce(up.signup_utm_source, '(direct / none)') as src, coalesce(up.signup_utm_campaign, '') as campaign, count(*)::int as n
from auth.users u cross join p left join user_profiles up on up.user_id = u.id
where ${since('u.created_at')} and not (u.id = any(p.uids))
group by 1, 2 order by 3 desc limit 12`

QUERIES.acq_invites = `with ${P}
select
  (select count(*) from individual_invite_codes)::int as codes,
  (select coalesce(sum(redemption_count), 0) from individual_invite_codes)::int as redemptions,
  (select count(*) from individual_invite_redemptions r, p where ${since('r.redeemed_at')} and ${exU('r')})::int as redemptions_period`

QUERIES.acq_referrals = `with ${P}
select count(*)::int as total,
  count(*) filter (where ${since('r.created_at')})::int as period,
  count(distinct r.referrer_id)::int as referrers
from referrals r cross join p
where ${exU('r', 'referred_user_id')}`

QUERIES.visitor_counter = `select "count"::int as n from site_visitor_counter where id = 1`

// Messages sent, by source, and email types
QUERIES.notif_sent = `with ${P}
select n.source, count(*)::int as sent
from notification_log n cross join p
where ${since('n.sent_at')} and ${exU('n')}
group by 1 order by 2 desc`

QUERIES.email_sent = `with ${P}
select e.email_type, count(*)::int as sent
from email_send_log e cross join p
where ${since('e.sent_at')} and ${exU('e')}
group by 1 order by 2 desc`

// Habit and opt-out state
QUERIES.prefs = `with ${P}
select count(*)::int as total,
  count(*) filter (where u.brief_cadence is not null)::int         as cadence_chosen,
  count(*) filter (where u.weekly_brief_opted_out)::int            as weekly_out,
  count(*) filter (where u.pattern_notice_opted_out)::int          as pattern_out,
  count(*) filter (where u.daily_nudge_opted_out)::int             as daily_out,
  count(*) filter (where u.validation_nudge_opted_out)::int        as validation_out
from user_preferences u cross join p where ${exU('u')}`

QUERIES.cadence = `with ${P}
select coalesce(u.brief_cadence, '(not chosen)') as cadence, count(*)::int as n
from user_preferences u cross join p where ${exU('u')}
group by 1 order by 2 desc`

// Which model handled each AI call (only populated when TIERED_ROUTING_ENABLED=true)
QUERIES.ai_usage = `with ${P}
select l.tier, l.role, l.resolved_target as target, count(*)::int as calls,
       count(*) filter (where l.was_override)::int as overrides
from ai_request_log l cross join p
where ${since('l.created_at')} and not (coalesce(l.user_id, '${NIL}'::uuid) = any(p.uids))
group by 1, 2, 3 order by 4 desc limit 20`

// Is this database login being filtered by Row Level Security? (If so, tables can read as empty.)
QUERIES.db_identity = `select current_user::text as db_user, (r.rolsuper or r.rolbypassrls) as bypass,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity)::int as rls_tables,
  exists (select 1 from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'sessions'
    and pl.roles @> array[current_user::name] and pl.qual = 'true') as has_read_policy
from pg_roles r where r.rolname = current_user`

// Institutional accounts
QUERIES.institutions = `with ${P}
select
  (select count(*) from institutions)::int                                              as institutions,
  (select count(*) from institutions i, p where ${since('i.created_at')})::int          as institutions_period,
  (select count(*) from institution_memberships m, p where ${exU('m')})::int            as members,
  (select count(*) from institution_memberships m, p where ${since('m.joined_at')} and ${exU('m')})::int as members_period,
  (select count(*) from institution_memberships m, p where m.consent_aggregate is true and ${exU('m')})::int as consented,
  (select count(*) from cohorts)::int                                                   as cohorts`

// ── Feature adoption: rows + distinct people per feature (table list is a constant) ──
const FEATURES = [
  { key: 'watchlist',   label: 'Watchlist notes',                    table: 'watchlist_items',          time: 'created_at' },
  { key: 'context',     label: 'Memory import started',              table: 'context_ingestion',        time: 'created_at' },
  { key: 'facts',       label: 'Memory facts accepted',              table: 'user_memory_facts',        time: 'created_at', where: `t.status in ('accepted','edited')` },
  { key: 'stakeholders',label: 'Stakeholders added',                 table: 'stakeholders',             time: 'created_at' },
  { key: 'connectors',  label: 'Connectors linked (Gmail, Slack...)', table: 'connector_accounts',      time: 'connected_at', where: 't.revoked_at is null' },
  { key: 'push',        label: 'Push notifications enabled',         table: 'push_subscriptions',       time: 'created_at' },
  { key: 'case_study',  label: 'Case study submissions',             table: 'case_study_submissions',   time: 'created_at' },
  { key: 'avoidance',   label: 'Avoidance alerts raised',            table: 'avoidance_alerts',         time: 'detected_at' },
  { key: 'graph',       label: 'Decision graph links',               table: 'graph_edges',              time: 'computed_at' },
  { key: 'contradict',  label: 'Contradictions detected',            table: 'contradictions',           time: 'generated_at' },
]

function featureSql(f) {
  return `with ${P}
select count(*)::int as rows_total, count(distinct t.user_id)::int as people_total,
  count(*) filter (where ${since('t.' + f.time)})::int as rows_period,
  count(distinct t.user_id) filter (where ${since('t.' + f.time)})::int as people_period
from ${f.table} t cross join p
where ${exU('t')}${f.where ? ' and ' + f.where : ''}`
}

// ── Execution ────────────────────────────────────────────────────────────────
async function safe(fn) {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    // Message only (never the SQL or connection string). Postgres messages name the missing table/column.
    return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) }
  }
}

// test accounts to leave out of every number
let exclCache = { at: 0, value: null }
async function resolveExclusions() {
  const emails = (process.env.EXCLUDE_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (!emails.length) return { uids: [], dids: [], emails: 0, matched: 0 }
  if (exclCache.value && Date.now() - exclCache.at < 5 * 60_000) return exclCache.value

  const users = await safe(() => q(`select id::text as id from auth.users where lower(email) = any($1::text[])`, [emails]))
  if (!users.ok) {
    // Do NOT cache a failure: otherwise one database blip would silently include test accounts for minutes.
    return { uids: [], dids: [], emails: emails.length, matched: 0, error: users.error }
  }
  const uids = users.data.map(r => r.id)
  const dids = new Set()
  if (uids.length) {
    for (const t of ['sessions', 'chat_intakes', 'events']) {
      const r = await safe(() => q(`select distinct device_id from ${t} where user_id = any($1::uuid[]) and device_id is not null`, [uids]))
      if (r.ok) r.data.forEach(x => dids.add(x.device_id))
    }
  }
  const value = { uids, dids: [...dids], emails: emails.length, matched: uids.length }
  exclCache = { at: Date.now(), value }
  return value
}

function prices() {
  const n = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]))
  return {
    monthly: n('PRICE_MONTHLY_INR', 2999),
    annual: n('PRICE_ANNUAL_INR', 29999),
    foundingMonthly: n('PRICE_FOUNDING_MONTHLY_INR', 999),
    foundingAnnual: n('PRICE_FOUNDING_ANNUAL_INR', 9999),
  }
}

function estimateMrr(rows, pr) {
  let mrr = 0
  for (const r of rows) {
    const regular = r.active - r.founding_active
    if (r.access_type === 'monthly') mrr += regular * pr.monthly + r.founding_active * pr.foundingMonthly
    if (r.access_type === 'annual') mrr += (regular * pr.annual + r.founding_active * pr.foundingAnnual) / 12
  }
  return Math.round(mrr)
}

async function compute(days) {
  const t0 = Date.now()
  const ex = await resolveExclusions()
  const params = [ex.uids, ex.dids, days, TZ]

  const names = Object.keys(QUERIES)
  const results = {}
  await Promise.all([
    ...names.map(async name => { results[name] = await safe(() => q(QUERIES[name], paramsFor(name, params))) }),
    ...FEATURES.map(async f => {
      results['feature:' + f.key] = await safe(async () => (await q(featureSql(f), params))[0])
    }),
  ])

  // unwrap single-row results for convenience
  const single = ['overview', 'signups', 'journey', 'flags', 'outcomes', 'acq_invites', 'acq_referrals',
    'visitor_counter', 'prefs', 'institutions', 'events_coverage', 'db_identity']
  for (const k of single) if (results[k].ok) results[k].data = results[k].data[0] || null

  const pr = prices()
  const mrr = results.access.ok ? estimateMrr(results.access.data, pr) : null

  const features = FEATURES.map(f => ({ key: f.key, label: f.label, ...results['feature:' + f.key] }))
  for (const f of FEATURES) delete results['feature:' + f.key]

  return {
    generated_at: new Date().toISOString(),
    took_ms: Date.now() - t0,
    params: { days, tz: TZ },
    exclusions: { emails: ex.emails, matched_users: ex.matched, devices: ex.dids.length, error: ex.error || null },
    prices: pr,
    mrr_estimate: mrr,
    features,
    sections: results,
  }
}

// queries that do not use all four params still need exactly the params they reference;
// ours all go through the `p` CTE except these three which are plain selects.
function paramsFor(name, params) {
  if (['events_coverage', 'visitor_counter', 'guest_by_source', 'db_identity'].includes(name)) return []
  return params
}

// ── Cache (also collapses concurrent requests for the same window) ──
const cache = new Map()
async function getMetrics(days, { force = false } = {}) {
  const key = String(days)
  const hit = cache.get(key)
  if (!force && hit && (hit.promise || Date.now() - hit.at < CACHE_TTL_MS)) return hit.promise || hit.value
  const promise = compute(days).then(value => { cache.set(key, { at: Date.now(), value }); return value })
    .catch(err => { cache.delete(key); throw err })
  cache.set(key, { at: Date.now(), promise })
  return promise
}

module.exports = { getMetrics, TZ }
