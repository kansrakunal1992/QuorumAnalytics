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
// The window is a range of calendar days in the dashboard timezone: [from_d, to_d] inclusive.
//   start_ts = midnight starting from_d, end_ts = midnight ending to_d (exclusive),
//   prev_ts  = start of the equal-length window immediately before it.
// Headline numbers and the day-by-day tables therefore always add up.
const P = `p0 as (select $1::uuid[] as uids, $2::text[] as dids, $3::date as from_d, $4::date as to_d, $5::text as tz),
p as (
  select p0.*,
    (p0.to_d - p0.from_d + 1)                                         as days,
    p0.from_d::timestamp at time zone p0.tz                           as start_ts,
    (p0.to_d + 1)::timestamp at time zone p0.tz                       as end_ts,
    (p0.from_d - (p0.to_d - p0.from_d + 1))::timestamp at time zone p0.tz as prev_ts
  from p0
)`
const since = col => `(${col} >= p.start_ts and ${col} < p.end_ts)`
const prevWindow = col => `(${col} >= p.prev_ts and ${col} < p.start_ts)`
// exclusion for tables with user_id + device_id
const exUD = a =>
  `not (coalesce(${a}.user_id, '${NIL}'::uuid) = any(p.uids)) and not (coalesce(${a}.device_id, '') = any(p.dids))`
// A tester's chat, and every event before they sign in, carries NO user or device id: the session only becomes theirs when
// it is linked at sign-in (which the sign-in-before-Council gate now makes the normal path). So also exclude a row when the
// SESSION it belongs to is owned by an excluded account or browser.
const sessionOwnerExcluded = sessionExpr =>
  `exists (select 1 from sessions xs where xs.id = ${sessionExpr} and (xs.user_id = any(p.uids) or coalesce(xs.device_id, '') = any(p.dids)))`
// events: join by the event's session id, or by the chat it names (council_launch_requested and the intake events carry only chat_intake_id)
const exEv = a => `${exUD(a)}
  and not (${a}.session_id is not null and ${sessionOwnerExcluded(`${a}.session_id`)})
  and not (${a}.props->>'chat_intake_id' is not null and ${sessionOwnerExcluded(`(select ci.session_id from chat_intakes ci where ci.id::text = ${a}.props->>'chat_intake_id')`)})`
// chat intakes: join by the session the chat created
const exChat = a => `${exUD(a)} and not (${a}.session_id is not null and ${sessionOwnerExcluded(`${a}.session_id`)})`
// exclusion for tables with only a user id column
const exU = (a, col = 'user_id') => `not (coalesce(${a}.${col}, '${NIL}'::uuid) = any(p.uids))`
// every calendar day in the window
const DAYS_CTE = `d as (
  select g::date as day from p,
  generate_series(p.from_d::timestamp, p.to_d::timestamp, interval '1 day') g
)`
// browser -> signed-in user, when the same browser ever signed in
const DEV_CTE = `dev as (
  select device_id, (array_agg(user_id))[1] as user_id
  from sessions where device_id is not null and user_id is not null
  group by device_id
)`

// A "person" is user_id when known, else the user_id of another session from the
// same browser (device), else the device id. This avoids double counting someone
// who decided anonymously and later signed in. Sessions with no user and no device
// (functional-cookie consent declined) cannot be attributed and have actor = null.
const BASE = `with ${P},
${DEV_CTE},
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

// ── Day by day (each source is its own query, so one missing table only blanks its columns) ──
QUERIES.daily = `${BASE},
${DAYS_CTE},
ss as (
  select (s.created_at at time zone p.tz)::date as day, count(*)::int as sessions, count(distinct s.actor)::int as people,
         count(*) filter (where x.session_depth = 'council')::int as council,
         count(x.final_decision_locked_at)::int as locked
  from s join sessions x on x.id = s.id cross join p where ${since('s.created_at')} group by 1
),
np as (
  select (f.first_at at time zone p.tz)::date as day, count(*)::int as new_people
  from (select actor, min(created_at) as first_at from s where actor is not null group by actor) f cross join p
  where ${since('f.first_at')} group by 1
),
su as (
  select (u.created_at at time zone p.tz)::date as day, count(*)::int as signups
  from auth.users u cross join p where ${since('u.created_at')} and not (u.id = any(p.uids)) group by 1
)
select d.day::text as day, coalesce(ss.sessions, 0) as sessions, coalesce(ss.people, 0) as people,
       coalesce(np.new_people, 0) as new_people, coalesce(ss.council, 0) as council, coalesce(ss.locked, 0) as locked,
       coalesce(su.signups, 0) as signups
from d left join ss using (day) left join np using (day) left join su using (day) order by 1`

QUERIES.events_daily = `with ${P},
${DAYS_CTE},
e as (
  select (ev.created_at at time zone p.tz)::date as day,
    count(*) filter (where ev.event = 'landing_view')           as landing,
    count(*) filter (where ev.event = 'decision_started')       as started,
    count(*) filter (where ev.event = 'decision_checkpointed')  as checkpointed,
    count(*) filter (where ev.event = 'decision_completed')     as completed,
    count(*) filter (where ev.event = 'auth_completed')         as sign_ins,
    count(*) filter (where ev.event = 'return_visit')           as returns,
    count(*) filter (where ev.event = 'paid_conversion')        as paid_conv,
    count(*) filter (where ev.event = 'council_launch_requested') as launched,
    count(*) filter (where ev.event = 'convene_gate_shown')     as gate_shown,
    count(*) filter (where ev.event = 'council_execution_started') as council_started
  from events ev cross join p
  where ${since('ev.created_at')} and ${exEv('ev')} group by 1
)
select d.day::text as day, coalesce(e.landing, 0)::int as landing, coalesce(e.started, 0)::int as started,
       coalesce(e.checkpointed, 0)::int as checkpointed, coalesce(e.completed, 0)::int as completed,
       coalesce(e.sign_ins, 0)::int as sign_ins, coalesce(e.returns, 0)::int as returns, coalesce(e.paid_conv, 0)::int as paid_conv,
       coalesce(e.launched, 0)::int as launched, coalesce(e.gate_shown, 0)::int as gate_shown, coalesce(e.council_started, 0)::int as council_started
from d left join e using (day) order by 1`

QUERIES.chats_daily = `with ${P},
${DAYS_CTE},
c as (
  select (c.created_at at time zone p.tz)::date as day, count(*)::int as chats,
         count(*) filter (where c.status = 'checkpointed')::int as confirmed
  from chat_intakes c cross join p where ${since('c.created_at')} and ${exChat('c')} group by 1
)
select d.day::text as day, coalesce(c.chats, 0) as chats, coalesce(c.confirmed, 0) as confirmed from d left join c using (day) order by 1`

QUERIES.money_daily = `with ${P},
${DAYS_CTE},
o as (
  select (x.created_at at time zone p.tz)::date as day, count(*)::int as orders
  from decision_session_payments x cross join p where ${since('x.created_at')} group by 1
),
pd as (
  select (x.paid_at at time zone p.tz)::date as day, count(*)::int as paid, coalesce(sum(x.amount_inr), 0)::int as revenue
  from decision_session_payments x cross join p
  where x.status = 'paid' and x.paid_at is not null and ${since('x.paid_at')} group by 1
)
select d.day::text as day, coalesce(o.orders, 0) as orders, coalesce(pd.paid, 0) as paid, coalesce(pd.revenue, 0) as revenue
from d left join o using (day) left join pd using (day) order by 1`

QUERIES.emails_daily = `with ${P},
${DAYS_CTE},
e as (
  select (x.sent_at at time zone p.tz)::date as day, count(*)::int as emails
  from email_send_log x cross join p where ${since('x.sent_at')} and ${exU('x')} group by 1
)
select d.day::text as day, coalesce(e.emails, 0) as emails from d left join e using (day) order by 1`

QUERIES.ai_daily = `with ${P},
${DAYS_CTE},
a as (
  select (x.created_at at time zone p.tz)::date as day, count(*)::int as calls
  from ai_request_log x cross join p
  where ${since('x.created_at')} and not (coalesce(x.user_id, '${NIL}'::uuid) = any(p.uids)) group by 1
)
select d.day::text as day, coalesce(a.calls, 0) as calls from d left join a using (day) order by 1`

// Front door: every tracked event, count + distinct people
QUERIES.events_funnel = `with ${P},
${DEV_CTE}
select ev.event, count(*)::int as n,
       count(distinct coalesce(ev.user_id::text, d.user_id::text, ev.device_id))::int as people,
       count(*) filter (where ev.user_id is null and ev.device_id is null)::int as unidentified
from events ev cross join p left join dev d on d.device_id = ev.device_id
where ${since('ev.created_at')} and ${exEv('ev')}
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
    when 'outcome_recorded'          then ev.props->>'source'
    when 'return_visit'              then ev.props->>'source'
    when 'council_specificity_feedback' then ev.props->>'specific'
    when 'consent_accepted'          then ev.props->>'via'
    when 'consent_rejected'          then ev.props->>'via'
    when 'payment_failed'            then ev.props->>'reason'
    when 'paywall_viewed'            then ev.props->>'plan'
    when 'checkout_opened'           then ev.props->>'plan'
    when 'payment_success'           then ev.props->>'plan'
    when 'checkout_dismissed'        then ev.props->>'plan'
  end, '(none)') as k,
  count(*)::int as n
from events ev cross join p
where ${since('ev.created_at')} and ${exEv('ev')}
  and ev.event in ('decision_completed','auth_completed','auth_prompt_seen','auth_started','install_prompt_seen',
                   'install_prompt_accepted','notification_opted_in','notification_opened','notification_to_decision',
                   'mirror_viewed','paid_conversion','mirror_unlocked','gate_arm_assigned','observation_seen',
                   'outcome_recorded','return_visit','council_specificity_feedback','consent_accepted','consent_rejected',
                   'payment_failed','paywall_viewed','checkout_opened','payment_success','checkout_dismissed')
group by 1, 2 order by 1, 3 desc`

// How much event history exists (events only started once Phase 0 shipped)
QUERIES.events_coverage = `select count(*)::int as n, min(created_at) as first_at, max(created_at) as last_at from events`

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

// How long after the 1st decision did the 2nd come? Separates one-sitting repeats from real return. All time.
QUERIES.repeat_gap = `${BASE},
r as (select actor, created_at, row_number() over (partition by actor order by created_at) as rn from s where actor is not null),
g as (select a.actor, b.created_at - a.created_at as gap from r a join r b on a.actor = b.actor and a.rn = 1 and b.rn = 2)
select (select count(distinct actor) from r)::int as people,
  count(*)::int                                                                         as repeaters,
  count(*) filter (where gap < interval '1 hour')::int                                  as within_hour,
  count(*) filter (where gap >= interval '1 hour' and gap < interval '1 day')::int      as same_day,
  count(*) filter (where gap >= interval '1 day' and gap < interval '7 days')::int      as days_1_7,
  count(*) filter (where gap >= interval '7 days' and gap < interval '30 days')::int    as days_7_30,
  count(*) filter (where gap >= interval '30 days')::int                                as days_30_plus
from g`

// Can we even reach the people whose 30-day check-in is due? (signed-in = reachable by email.) All time.
QUERIES.outcome_reach = `${BASE}
select count(*)::int as eligible,
  count(*) filter (where s.linked)::int as eligible_linked,
  count(*) filter (where exists (select 1 from outcomes o where o.session_id = s.id))::int as with_outcome,
  count(*) filter (where s.linked and exists (select 1 from outcomes o where o.session_id = s.id))::int as linked_with_outcome
from s where s.status = 'completed' and s.created_at < now() - interval '30 days'`

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


// ════════════════════════════════════════════════════════════════════════════════════════════════
// v14: the journey in plain steps. Front door (visits, cookie banner) -> each chat (per chat started) -> after the Council.
// Rows from the events table only exist from the day that event shipped; funnel_first_seen says when, so the page can
// say "measured since ..." instead of showing a misleading 0.
// ════════════════════════════════════════════════════════════════════════════════════════════════
QUERIES.funnel_visits = `with ${P}
select
  count(*) filter (where ev.event = 'landing_view')::int                                       as landing_views,
  count(distinct coalesce(ev.user_id::text, ev.device_id, ev.props->>'vh')) filter (where ev.event = 'landing_view')::int as visitors_est,
  count(distinct ev.props->>'vh') filter (where ev.event = 'landing_view')::int               as visitors_hash,
  count(*) filter (where ev.event = 'landing_view' and ev.user_id is null and ev.device_id is null and ev.props->>'vh' is null)::int as unidentified_views,
  count(*) filter (where ev.event = 'landing_view' and coalesce(ev.props->>'in_app', 'none') not in ('none'))::int as in_app_views,
  count(*) filter (where ev.event = 'consent_shown')::int                                      as consent_shown,
  count(*) filter (where ev.event = 'consent_accepted')::int                                   as consent_accepted,
  count(*) filter (where ev.event = 'consent_rejected')::int                                   as consent_rejected
from events ev cross join p
where ${since('ev.created_at')} and ${exEv('ev')}`

QUERIES.funnel_first_seen = `select event, min(created_at) as first_at from events group by 1`

QUERIES.funnel_chain = `with ${P},
ci as (
  select c.id, c.session_id, c.status from chat_intakes c cross join p where ${since('c.created_at')} and ${exChat('c')}
),
f as (
  select ci.id,
    (ci.status = 'checkpointed')                                                                                  as saved,
    exists (select 1 from events e where e.event = 'intake_summary_shown'    and e.props->>'chat_intake_id' = ci.id::text) as summary,
    exists (select 1 from events e where e.event = 'council_launch_requested' and e.props->>'chat_intake_id' = ci.id::text) as launched,
    exists (select 1 from events e where e.event = 'convene_gate_shown'      and e.session_id = ci.session_id)       as gate,
    exists (select 1 from messages m where m.session_id = ci.session_id and m.role = 'assistant')                    as council_started,
    exists (select 1 from synthesis_versions sv where sv.session_id = ci.session_id and sv.version = 0)             as finished,
    exists (select 1 from messages m where m.session_id = ci.session_id and m.role = 'user')                         as pushback,
    exists (select 1 from events e where e.event = 'council_specificity_feedback' and e.session_id = ci.session_id)  as rated,
    exists (select 1 from events e where e.event = 'council_specificity_feedback' and e.session_id = ci.session_id and e.props->>'specific' = 'yes')     as rated_yes,
    exists (select 1 from events e where e.event = 'council_specificity_feedback' and e.session_id = ci.session_id and e.props->>'specific' = 'partly')  as rated_partly,
    exists (select 1 from events e where e.event = 'council_specificity_feedback' and e.session_id = ci.session_id and e.props->>'specific' = 'no')      as rated_no,
    (s.final_decision_locked_at is not null)                                                                         as locked,
    (s.commitment_review_date is not null
       or exists (select 1 from events e where e.event = 'review_date_chosen' and e.session_id = ci.session_id))     as review_set,
    exists (select 1 from events e where e.event = 'record_viewed' and e.session_id = ci.session_id)                as record_opened,
    exists (select 1 from outcomes o where o.session_id = ci.session_id)                                            as outcome,
    coalesce(s.is_shared, false)                                                                                    as shared
  from ci left join sessions s on s.id = ci.session_id
)
select count(*)::int as started,
  count(*) filter (where saved)::int           as saved,
  count(*) filter (where summary)::int         as summary,
  count(*) filter (where launched)::int        as launched,
  count(*) filter (where gate)::int            as gate,
  count(*) filter (where gate and council_started)::int as gate_passed,
  count(*) filter (where council_started)::int as council_started,
  count(*) filter (where finished)::int        as finished,
  count(*) filter (where pushback)::int        as pushback,
  count(*) filter (where rated)::int           as rated,
  count(*) filter (where rated_yes)::int       as rated_yes,
  count(*) filter (where rated_partly)::int    as rated_partly,
  count(*) filter (where rated_no)::int        as rated_no,
  count(*) filter (where locked)::int          as locked,
  count(*) filter (where review_set)::int      as review_set,
  count(*) filter (where record_opened)::int   as record_opened,
  count(*) filter (where outcome)::int         as outcome,
  count(*) filter (where shared)::int          as shared
from f`

// People who hit the sign-in step: how many continued, split by the browser they were in
QUERIES.gate_outcome = `with ${P}
select coalesce(e.props->>'in_app', 'unknown') as in_app,
  count(distinct e.session_id)::int as shown,
  count(distinct e.session_id) filter (where exists (select 1 from messages m where m.session_id = e.session_id and m.role = 'assistant'))::int as continued
from events e cross join p
where e.event = 'convene_gate_shown' and e.session_id is not null and ${since('e.created_at')} and ${exEv('e')}
group by 1 order by 2 desc`

// Which channels bring people, and how far each gets
QUERIES.channels = `with ${P}
select coalesce(ev.props->>'utm_source', case when ev.props->>'ref' is not null then 'site: ' || (ev.props->>'ref') end, 'direct / unknown') as source,
  coalesce(ev.props->>'utm_medium', '')   as medium,
  coalesce(ev.props->>'utm_campaign', '') as campaign,
  coalesce(ev.props->>'utm_content', '')  as content,
  count(*) filter (where ev.event = 'landing_view')::int       as views,
  count(*) filter (where ev.event = 'decision_started')::int   as started,
  count(*) filter (where ev.event = 'convene_gate_shown')::int as gate,
  count(*) filter (where ev.event = 'paywall_viewed')::int     as paywall,
  count(*) filter (where ev.event = 'payment_success')::int    as paid
from events ev cross join p
where ev.event in ('landing_view','decision_started','convene_gate_shown','paywall_viewed','payment_success')
  and ${since('ev.created_at')} and ${exEv('ev')}
group by 1, 2, 3, 4 order by 5 desc, 6 desc limit 30`

QUERIES.devices = `with ${P}
select coalesce(ev.props->>'device_class', 'unknown') as device, coalesce(ev.props->>'in_app', 'unknown') as in_app,
  count(*) filter (where ev.event = 'landing_view')::int       as views,
  count(*) filter (where ev.event = 'decision_started')::int   as started,
  count(*) filter (where ev.event = 'convene_gate_shown')::int as gate,
  count(*) filter (where ev.event = 'auth_started' and ev.props->>'method' = 'google')::int  as google_tries,
  count(*) filter (where ev.event = 'auth_started' and coalesce(ev.props->>'method', '') <> 'google')::int as email_tries
from events ev cross join p
where ev.event in ('landing_view','decision_started','convene_gate_shown','auth_started')
  and ${since('ev.created_at')} and ${exEv('ev')}
group by 1, 2 order by 3 desc limit 20`

// Failures people felt (a Council advisor that never answered, a 429, a failed checkout)
QUERIES.client_errors = `with ${P}
select coalesce(ev.props->>'where', '(unknown)') as place, coalesce(ev.props->>'kind', '(unknown)') as kind,
  count(*)::int as n,
  count(distinct coalesce(ev.session_id::text, ev.device_id, ev.user_id::text))::int as affected
from events ev cross join p
where ev.event = 'client_error' and ${since('ev.created_at')} and ${exEv('ev')}
group by 1, 2 order by 3 desc limit 20`

// How long people wait (the AI's part of the experience)
QUERIES.latency = `with ${P},
ms as (
  select ev.event, case when ev.props->>'api_ms' ~ '^[0-9]+(\\.[0-9]+)?$' then (ev.props->>'api_ms')::numeric end as api_ms,
         case when ev.props->>'ms_on_confirm' ~ '^[0-9]+(\\.[0-9]+)?$' then (ev.props->>'ms_on_confirm')::numeric end as confirm_ms
  from events ev cross join p where ev.event in ('intake_step_shown','council_launch_requested') and ${since('ev.created_at')} and ${exEv('ev')}
),
ci as (
  select c.id, c.session_id from chat_intakes c cross join p where ${since('c.created_at')} and ${exChat('c')} and c.session_id is not null
),
conv as (
  select extract(epoch from (
      (select min(e.created_at) from events e where e.event = 'council_execution_started' and e.session_id = ci.session_id)
    - (select min(e.created_at) from events e where e.event = 'council_launch_requested' and e.props->>'chat_intake_id' = ci.id::text)
  )) as secs
  from ci
  where not exists (select 1 from events g where g.event = 'convene_gate_shown' and g.session_id = ci.session_id)
)
select
  (select count(api_ms) from ms)::int                                                         as api_n,
  (select percentile_cont(0.5)  within group (order by api_ms) from ms where api_ms is not null)  as api_p50,
  (select percentile_cont(0.95) within group (order by api_ms) from ms where api_ms is not null)  as api_p95,
  (select count(confirm_ms) from ms)::int                                                     as confirm_n,
  (select percentile_cont(0.5)  within group (order by confirm_ms) from ms where confirm_ms is not null) as confirm_p50,
  (select count(secs) from conv where secs > 0 and secs < 600)::int                           as convene_n,
  (select percentile_cont(0.5)  within group (order by secs) from conv where secs > 0 and secs < 600) as convene_p50,
  (select percentile_cont(0.95) within group (order by secs) from conv where secs > 0 and secs < 600) as convene_p95`

// Sign-in prompts: who saw one, started, and later finished (matched by user OR browser, since the id changes at sign-in)
QUERIES.signin_prompts = `with ${P},
x as (
  select ev.event, ev.props->>'stage' as stage, ev.user_id::text as uid, ev.device_id as did, ev.created_at
  from events ev cross join p
  where ev.event in ('auth_prompt_seen','auth_started','auth_completed') and ${since('ev.created_at')} and ${exEv('ev')}
),
seen as (select coalesce(uid, did) as actor, coalesce(stage, '(unknown)') as stage, min(created_at) as t from x where event = 'auth_prompt_seen' and coalesce(uid, did) is not null group by 1, 2),
st   as (select coalesce(uid, did) as actor, coalesce(stage, '(unknown)') as stage from x where event = 'auth_started' and coalesce(uid, did) is not null group by 1, 2),
done as (select unnest(array[uid, did]) as actor, created_at as t from x where event = 'auth_completed')
select seen.stage, count(*)::int as seen,
  count(*) filter (where exists (select 1 from st where st.actor = seen.actor and st.stage = seen.stage))::int as started,
  count(*) filter (where exists (select 1 from done where done.actor = seen.actor and done.t >= seen.t))::int  as signed_in
from seen group by 1 order by 2 desc`

// Paywall -> checkout -> paid, by plan; and why payments fail
QUERIES.payments = `with ${P}
select coalesce(ev.props->>'plan', '(unknown)') as plan,
  count(*) filter (where ev.event = 'paywall_viewed')::int      as viewed,
  count(*) filter (where ev.event = 'checkout_opened')::int     as opened,
  count(*) filter (where ev.event = 'checkout_dismissed')::int  as dismissed,
  count(*) filter (where ev.event = 'payment_failed')::int      as failed,
  count(*) filter (where ev.event = 'payment_success')::int     as success
from events ev cross join p
where ev.event in ('paywall_viewed','checkout_opened','checkout_dismissed','payment_failed','payment_success')
  and ${since('ev.created_at')} and ${exEv('ev')}
group by 1 order by 2 desc`

// Guest orders: did the order come from a button press or from the page loading?
QUERIES.guest_orders = `with ${P}
select ev.event, coalesce(ev.props->>'trigger', 'n/a') as trigger, coalesce(ev.props->>'utm_source', '(none)') as src, count(*)::int as n
from events ev cross join p
where ev.event in ('guest_order_created','guest_order_paid') and ${since('ev.created_at')}
group by 1, 2, 3 order by 4 desc limit 30`

// Outcomes recorded, split by whether the visit came from one of our emails
QUERIES.outcome_sources = `with ${P}
select coalesce(ev.props->>'source', '(not from an email)') as source, count(*)::int as n
from events ev cross join p
where ev.event = 'outcome_recorded' and ${since('ev.created_at')} and ${exEv('ev')}
group by 1 order by 2 desc`

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

// RELEASE_MARKERS="2026-11-04:Sign-in gate and v14 tracking,2026-10-24:v10 shorter journey" -> drawn on the charts and
// used for the before/after check. Dates are YYYY-MM-DD in the dashboard timezone.
function releaseMarkers() {
  const out = []
  for (const part of (process.env.RELEASE_MARKERS || '').split(',')) {
    const i = part.indexOf(':')
    const date = (i > 0 ? part.slice(0, i) : part).trim()
    const label = (i > 0 ? part.slice(i + 1) : 'Release').trim().slice(0, 60) || 'Release'
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))) out.push({ date, label })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1))
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

// ── Date ranges ──────────────────────────────────────────────────────────────
const ISO = /^\d{4}-\d{2}-\d{2}$/
const ALLOWED_DAYS = new Set([7, 14, 30, 60, 90])
const DAY_MS = 86_400_000
const todayInTz = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10)

/** Turn ?days=30 or ?from=2026-10-01&to=2026-10-20 into {from,to,days,custom}. Throws a friendly Error on bad input. */
function resolveRange({ days, from, to } = {}) {
  const today = todayInTz()
  if (from || to) {
    if (!ISO.test(from || '') || !ISO.test(to || '') || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
      throw new Error('from and to must both be dates like 2026-10-01')
    if (from > to) throw new Error('from must be on or before to')
    if (to > today) throw new Error(`to cannot be after today (${today})`)
    const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1
    if (n > 366) throw new Error('the range can be at most 366 days')
    return { from, to, days: n, custom: true }
  }
  const d = Number(days || 30)
  if (!ALLOWED_DAYS.has(d)) throw new Error('days must be one of ' + [...ALLOWED_DAYS].join(', '))
  return { from: addDays(today, -(d - 1)), to: today, days: d, custom: false }
}

async function compute(range) {
  const t0 = Date.now()
  const ex = await resolveExclusions()
  const params = [ex.uids, ex.dids, range.from, range.to, TZ]

  const names = Object.keys(QUERIES)
  const results = {}
  await Promise.all([
    ...names.map(async name => { results[name] = await safe(() => q(QUERIES[name], paramsFor(name, params))) }),
    ...FEATURES.map(async f => {
      results['feature:' + f.key] = await safe(async () => (await q(featureSql(f), params))[0])
    }),
  ])

  // unwrap single-row results for convenience
  const single = ['overview', 'signups', 'flags', 'outcomes', 'acq_invites', 'acq_referrals',
    'visitor_counter', 'prefs', 'institutions', 'events_coverage', 'db_identity', 'repeat_gap', 'outcome_reach',
    'funnel_visits', 'funnel_chain', 'latency']
  for (const k of single) if (results[k].ok) results[k].data = results[k].data[0] || null

  const pr = prices()
  const mrr = results.access.ok ? estimateMrr(results.access.data, pr) : null

  const features = FEATURES.map(f => ({ key: f.key, label: f.label, ...results['feature:' + f.key] }))
  for (const f of FEATURES) delete results['feature:' + f.key]

  return {
    generated_at: new Date().toISOString(),
    took_ms: Date.now() - t0,
    params: { ...range, tz: TZ, today: todayInTz() },
    markers: releaseMarkers(),
    exclusions: { emails: ex.emails, matched_users: ex.matched, devices: ex.dids.length, error: ex.error || null },
    prices: pr,
    mrr_estimate: mrr,
    features,
    sections: results,
  }
}

// queries that are plain selects (no `p` CTE) take no parameters
function paramsFor(name, params) {
  if (['events_coverage', 'visitor_counter', 'guest_by_source', 'db_identity', 'funnel_first_seen'].includes(name)) return []
  return params
}

// ── Cache (also collapses concurrent requests for the same window) ──
const cache = new Map()
async function getMetrics(input, { force = false } = {}) {
  const range = typeof input === 'number' ? resolveRange({ days: input }) : input && input.custom !== undefined ? input : resolveRange(input)
  const key = `${range.from}_${range.to}`
  const hit = cache.get(key)
  if (!force && hit && (hit.promise || Date.now() - hit.at < CACHE_TTL_MS)) return hit.promise || hit.value
  const promise = compute(range).then(value => { cache.set(key, { at: Date.now(), value }); return value })
    .catch(err => { cache.delete(key); throw err })
  cache.set(key, { at: Date.now(), promise })
  return promise
}

module.exports = { getMetrics, resolveRange, TZ }
