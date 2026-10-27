-- Clients enforce their own customer allowances; the service keeps no lifetime quota by default.
-- NULL allowance means unlimited. An operator can still set a cap on a workspace.
ALTER TABLE service_workspaces ALTER COLUMN allowance_seconds DROP NOT NULL;
ALTER TABLE service_workspaces ALTER COLUMN allowance_seconds SET DEFAULT NULL;
UPDATE service_workspaces SET allowance_seconds = NULL WHERE allowance_seconds = 36000;
-- Simultaneous live interviews remain capped as runaway-cost protection, shared by every team of a client.
ALTER TABLE service_workspaces ALTER COLUMN concurrency_limit SET DEFAULT 25;
UPDATE service_workspaces SET concurrency_limit = 25 WHERE concurrency_limit = 5;
