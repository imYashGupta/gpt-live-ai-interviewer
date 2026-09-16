CREATE TABLE service_accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  environment text NOT NULL DEFAULT 'test' CHECK (environment = 'test'),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_workspaces (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES service_accounts(id),
  external_reference text NOT NULL,
  display_name text NOT NULL,
  allowance_seconds bigint NOT NULL DEFAULT 36000 CHECK (allowance_seconds >= 0),
  concurrency_limit integer NOT NULL DEFAULT 5 CHECK (concurrency_limit > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, external_reference), UNIQUE(id, account_id)
);
CREATE TABLE service_credentials (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES service_accounts(id),
  workspace_id text,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES service_workspaces(id, account_id)
);
CREATE TABLE service_interviews (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  workspace_id text NOT NULL,
  external_reference text NOT NULL,
  request jsonb NOT NULL,
  execution_status text NOT NULL DEFAULT 'ready' CHECK (execution_status IN ('ready','in_progress','completed','interrupted','failed','cancelled','expired')),
  assessment_status text NOT NULL DEFAULT 'not_requested' CHECK (assessment_status IN ('not_requested','pending','processing','ready','insufficient_evidence','failed')),
  usage_status text NOT NULL DEFAULT 'pending' CHECK (usage_status IN ('pending','provisional','settled')),
  resource_version integer NOT NULL DEFAULT 1,
  attempt_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, external_reference), UNIQUE(id, account_id, workspace_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES service_workspaces(id, account_id)
);
CREATE TABLE service_attempts (
  id text PRIMARY KEY,
  interview_id text NOT NULL UNIQUE REFERENCES service_interviews(id),
  provider text NOT NULL CHECK (provider = 'fake'),
  provider_reference text NOT NULL UNIQUE,
  observations jsonb NOT NULL DEFAULT '{}'::jsonb,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  ended_at timestamptz
);
ALTER TABLE service_interviews ADD CONSTRAINT service_interviews_attempt_fk FOREIGN KEY (attempt_id) REFERENCES service_attempts(id);
CREATE TABLE service_access_links (
  id text PRIMARY KEY,
  interview_id text NOT NULL REFERENCES service_interviews(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_candidate_sessions (
  id text PRIMARY KEY,
  interview_id text NOT NULL REFERENCES service_interviews(id),
  link_id text NOT NULL REFERENCES service_access_links(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE service_commands (
  account_id text NOT NULL REFERENCES service_accounts(id),
  credential_id text NOT NULL REFERENCES service_credentials(id),
  workspace_id text REFERENCES service_workspaces(id),
  operation text NOT NULL,
  command_key text NOT NULL,
  request_hash text NOT NULL,
  response_ciphertext text NOT NULL,
  response_status integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, operation, command_key)
);
CREATE TABLE service_reservations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES service_workspaces(id),
  interview_id text NOT NULL UNIQUE REFERENCES service_interviews(id),
  attempt_id text NOT NULL UNIQUE REFERENCES service_attempts(id),
  reserved_seconds bigint NOT NULL CHECK (reserved_seconds > 0),
  status text NOT NULL CHECK (status IN ('reserved','released','settled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_usage (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  workspace_id text NOT NULL REFERENCES service_workspaces(id),
  attempt_id text NOT NULL UNIQUE REFERENCES service_attempts(id),
  measured_seconds bigint NOT NULL CHECK (measured_seconds >= 0),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES service_accounts(id),
  workspace_id text NOT NULL REFERENCES service_workspaces(id),
  interview_id text NOT NULL REFERENCES service_interviews(id),
  type text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_webhook_endpoints (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES service_accounts(id),
  url text NOT NULL,
  secret_ciphertext text NOT NULL,
  event_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, url)
);
CREATE TABLE service_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('execute','assess','deliver')),
  dedupe_key text NOT NULL UNIQUE,
  interview_id text REFERENCES service_interviews(id),
  event_id text REFERENCES service_events(id),
  endpoint_id text REFERENCES service_webhook_endpoints(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_legacy_imports (
  source_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES service_accounts(id),
  legacy_id text NOT NULL,
  snapshot jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, legacy_id)
);
CREATE INDEX service_jobs_poll_idx ON service_jobs(available_at, created_at) WHERE status IN ('pending','running');
CREATE INDEX service_interviews_workspace_idx ON service_interviews(workspace_id, updated_at, id);
CREATE INDEX service_events_account_idx ON service_events(account_id, sequence);
CREATE INDEX service_usage_workspace_idx ON service_usage(workspace_id, sequence);
CREATE INDEX service_reservations_workspace_idx ON service_reservations(workspace_id) WHERE status = 'reserved';
