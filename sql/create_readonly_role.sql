-- OPTIONAL, recommended: a database login that can only read the handful of columns the
-- dashboard needs. Decision text, messages, notes and every other content column are
-- NOT granted, so even if this connection string leaked it could not read them.
--
-- How to use
--   1. Change the password on the "create role" line below (and keep it somewhere safe).
--   2. Paste this whole file into the Supabase SQL Editor and run it.
--   3. In Railway, set DATABASE_URL using the user  dashboard_ro.<your-project-ref>
--      (the Supabase pooler needs the project ref appended to the user name).
--
-- Safe to run more than once. Tables that do not exist in your database are skipped, and
-- you will see a NOTICE for each skipped table or column.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    create role dashboard_ro login password 'CHANGE-ME-to-a-long-random-password';
  end if;
end $$;

do $$
begin
  execute format('grant connect on database %I to dashboard_ro', current_database());
end $$;
grant usage on schema public to dashboard_ro;

-- Column-level grants: (table, columns the dashboard reads)
do $$
declare
  r record;
  col text;
begin
  for r in select * from (values
    ('sessions',                  'id,user_id,device_id,created_at,status,session_depth,intake_mode,register_mode,post_decision_confidence,final_decision_locked_at,is_shared,commitment_captured_at,council_nudge_sent_at,parent_session_id,initial_instinct,optimization_priority,quorum_prediction_generated_at'),
    ('messages',                  'session_id,persona,role,created_at'),
    ('chat_intakes',              'id,user_id,device_id,status,exchange_count,session_id,created_at'),
    ('examiner_responses',        'session_id'),
    ('synthesis_versions',        'session_id,version'),
    ('outcomes',                  'session_id,council_helped,created_at'),
    ('events',                    'event,user_id,device_id,props,created_at'),
    ('mirror_access',             'user_id,access_type,product_tier,expires_at,founding_member'),
    ('decision_session_payments', 'status,amount_inr,paid_at,created_at,utm_source'),
    ('user_profiles',             'user_id,signup_utm_source,signup_utm_campaign'),
    ('individual_invite_codes',   'redemption_count'),
    ('individual_invite_redemptions', 'redeemed_at,user_id'),
    ('referrals',                 'referrer_id,referred_user_id,created_at'),
    ('site_visitor_counter',      'id,count'),
    ('notification_log',          'user_id,source,sent_at'),
    ('email_send_log',            'user_id,email_type,sent_at'),
    ('user_preferences',          'user_id,brief_cadence,weekly_brief_opted_out,pattern_notice_opted_out,daily_nudge_opted_out,validation_nudge_opted_out'),
    ('ai_request_log',            'user_id,tier,role,resolved_target,was_override,created_at'),
    ('institutions',              'created_at'),
    ('institution_memberships',   'user_id,joined_at,consent_aggregate'),
    ('cohorts',                   'id'),
    ('watchlist_items',           'user_id,created_at'),
    ('context_ingestion',         'user_id,created_at'),
    ('user_memory_facts',         'user_id,created_at,status'),
    ('stakeholders',              'user_id,created_at'),
    ('connector_accounts',        'user_id,connected_at,revoked_at'),
    ('push_subscriptions',        'user_id,created_at'),
    ('case_study_submissions',    'user_id,created_at'),
    ('avoidance_alerts',          'user_id,detected_at'),
    ('graph_edges',               'user_id,computed_at'),
    ('contradictions',            'user_id,generated_at')
  ) as t(tbl, cols)
  loop
    if to_regclass('public.' || quote_ident(r.tbl)) is null then
      raise notice 'skipped table % (does not exist)', r.tbl;
      continue;
    end if;
    -- Your tables use Row Level Security. A custom login sees ZERO rows unless it has a policy,
    -- so give dashboard_ro an explicit read-everything policy (read access is still limited to the granted columns).
    if (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || quote_ident(r.tbl))) then
      execute format('drop policy if exists dashboard_ro_read on public.%I', r.tbl);
      execute format('create policy dashboard_ro_read on public.%I for select to dashboard_ro using (true)', r.tbl);
    end if;
    foreach col in array string_to_array(r.cols, ',') loop
      if exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = r.tbl and column_name = col) then
        execute format('grant select (%I) on public.%I to dashboard_ro', col, r.tbl);
      else
        raise notice 'skipped column %.% (does not exist)', r.tbl, col;
      end if;
    end loop;
  end loop;
end $$;

-- Supabase auth: signup counts and the test-account lookup need these four columns.
-- (If Supabase refuses this grant, the Signups panel will show an error; everything else still works.
--  In that case either skip this role or ask support to enable it.)
do $$
begin
  grant usage on schema auth to dashboard_ro;
  grant select (id, email, created_at, last_sign_in_at, raw_app_meta_data) on auth.users to dashboard_ro;
exception when others then
  raise notice 'Could not grant on auth.users: %', sqlerrm;
end $$;

-- Belt and braces: this login can never write, whatever else is granted later.
alter role dashboard_ro set default_transaction_read_only = on;
