-- The relay judge per org, off until an owner turns it on.
ALTER TABLE orgs ADD COLUMN judge_enabled INTEGER DEFAULT 0;
