-- Cron control (task 4): the dashboard needs the Hermes profile and the deliver targets per job.
-- Run BEFORE deploying the code that selects these columns. Safe to re-run.
-- RLS is already enabled on hermyhq.agent_job (migration that created the table); adding columns
-- does not change that and needs no new policy.
ALTER TABLE hermyhq.agent_job ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'default';
ALTER TABLE hermyhq.agent_job ADD COLUMN IF NOT EXISTS deliver text;
ALTER TABLE hermyhq.agent_job ADD COLUMN IF NOT EXISTS failure_deliver text;
