-- Existing interviews stay synthetic. Routing is pinned when each interview is created.
ALTER TABLE service_interviews ADD COLUMN execution_provider text NOT NULL DEFAULT 'fake'
  CHECK (execution_provider IN ('fake', 'openai_live'));
ALTER TABLE service_attempts DROP CONSTRAINT service_attempts_provider_check;
ALTER TABLE service_attempts ADD CONSTRAINT service_attempts_provider_check CHECK (provider IN ('fake', 'openai_live'));
ALTER TABLE service_attempts ADD COLUMN connection_state text NOT NULL DEFAULT 'queued'
  CHECK (connection_state IN ('queued','creating','created','observing','closed','uncertain'));
ALTER TABLE service_attempts ADD COLUMN offer_hash text;
ALTER TABLE service_attempts ADD COLUMN offer_ciphertext text;
ALTER TABLE service_attempts ADD COLUMN answer_ciphertext text;
ALTER TABLE service_attempts ADD COLUMN stop_requested_at timestamptz;
ALTER TABLE service_attempts ADD COLUMN stop_reason text;
ALTER TABLE service_attempts ADD COLUMN observer_ready_at timestamptz;
ALTER TABLE service_attempts ADD COLUMN consent_version text;
ALTER TABLE service_attempts ADD COLUMN consent_at timestamptz;
CREATE TABLE service_observations (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES service_attempts(id),
  event_id text NOT NULL,
  observation jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, event_id)
);
CREATE INDEX service_observations_attempt_idx ON service_observations(attempt_id, sequence);
