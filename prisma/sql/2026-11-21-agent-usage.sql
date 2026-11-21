-- /kulu (cost & profiles): tables filled by Argo's hermy_usage_sync.py via /api/ingest/hermes-usage.
-- Apply BEFORE deploying the code that reads them (Supabase project ekjvvzlewdafnyiblrbu, migration
-- name hermyhq_agent_usage). Safe to re-run.
-- Same convention as hermyhq.agent_job / wiki_snapshot: schema hermyhq is not exposed to PostgREST,
-- RLS is enabled in this same migration, policies and grants go only to the app role hermyhq;
-- anon/authenticated get nothing. The account balance goes to the existing hermyhq."DataStore"
-- (key 'hermes-balance'), so it needs no table here.

CREATE TABLE IF NOT EXISTS hermyhq.agent_usage_day (
  source                text             NOT NULL DEFAULT 'argo',
  profile               text             NOT NULL,
  day                   date             NOT NULL,
  sessions              integer          NOT NULL,
  empty_sessions        integer          NOT NULL,
  unpriced_sessions     integer          NOT NULL,
  subscription_sessions integer          NOT NULL,
  input_tokens          bigint           NOT NULL,
  output_tokens         bigint           NOT NULL,
  cache_read_tokens     bigint           NOT NULL,
  cache_write_tokens    bigint           NOT NULL,
  cost_usd              double precision,
  subscription_cost_usd double precision,
  models                jsonb            NOT NULL,
  platforms             jsonb            NOT NULL,
  synced_at             timestamp(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT agent_usage_day_pkey PRIMARY KEY (source, profile, day)
);
CREATE INDEX IF NOT EXISTS agent_usage_day_day_idx ON hermyhq.agent_usage_day (day);

CREATE TABLE IF NOT EXISTS hermyhq.agent_profile (
  source       text         NOT NULL DEFAULT 'argo',
  profile      text         NOT NULL,
  display_name text,
  model        text,
  provider     text,
  subscription boolean      NOT NULL DEFAULT false,
  gateway      text,
  cron_count   integer      NOT NULL,
  cron_enabled integer      NOT NULL,
  synced_at    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT agent_profile_pkey PRIMARY KEY (source, profile)
);

ALTER TABLE hermyhq.agent_usage_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE hermyhq.agent_profile ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON hermyhq.agent_usage_day, hermyhq.agent_profile FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON hermyhq.agent_usage_day, hermyhq.agent_profile TO hermyhq;

DROP POLICY IF EXISTS agent_usage_day_app_select ON hermyhq.agent_usage_day;
DROP POLICY IF EXISTS agent_usage_day_app_insert ON hermyhq.agent_usage_day;
DROP POLICY IF EXISTS agent_usage_day_app_update ON hermyhq.agent_usage_day;
DROP POLICY IF EXISTS agent_usage_day_app_delete ON hermyhq.agent_usage_day;
CREATE POLICY agent_usage_day_app_select ON hermyhq.agent_usage_day FOR SELECT TO hermyhq USING (true);
CREATE POLICY agent_usage_day_app_insert ON hermyhq.agent_usage_day FOR INSERT TO hermyhq WITH CHECK (true);
CREATE POLICY agent_usage_day_app_update ON hermyhq.agent_usage_day FOR UPDATE TO hermyhq USING (true) WITH CHECK (true);
CREATE POLICY agent_usage_day_app_delete ON hermyhq.agent_usage_day FOR DELETE TO hermyhq USING (true);

DROP POLICY IF EXISTS agent_profile_app_select ON hermyhq.agent_profile;
DROP POLICY IF EXISTS agent_profile_app_insert ON hermyhq.agent_profile;
DROP POLICY IF EXISTS agent_profile_app_update ON hermyhq.agent_profile;
DROP POLICY IF EXISTS agent_profile_app_delete ON hermyhq.agent_profile;
CREATE POLICY agent_profile_app_select ON hermyhq.agent_profile FOR SELECT TO hermyhq USING (true);
CREATE POLICY agent_profile_app_insert ON hermyhq.agent_profile FOR INSERT TO hermyhq WITH CHECK (true);
CREATE POLICY agent_profile_app_update ON hermyhq.agent_profile FOR UPDATE TO hermyhq USING (true) WITH CHECK (true);
CREATE POLICY agent_profile_app_delete ON hermyhq.agent_profile FOR DELETE TO hermyhq USING (true);

-- Verify after applying (expected: anon_select=false, auth_select=false, app_insert=true, rls=true for both):
-- select t, has_table_privilege('anon', t, 'select') as anon_select,
--        has_table_privilege('authenticated', t, 'select') as auth_select,
--        has_table_privilege('hermyhq', t, 'insert') as app_insert,
--        (select relrowsecurity from pg_class where oid = t::regclass) as rls
-- from unnest(array['hermyhq.agent_usage_day', 'hermyhq.agent_profile']) as t;
-- Then get_advisors(type: security): no new finding may mention agent_usage_day or agent_profile.
