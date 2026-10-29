-- One video recording per attempt. Media lives in S3 under object_prefix; these rows hold only keys, sizes and timing.
CREATE TABLE service_recordings (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES service_accounts(id),
  interview_id text NOT NULL REFERENCES service_interviews(id),
  attempt_id text NOT NULL UNIQUE REFERENCES service_attempts(id),
  object_prefix text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('video/webm','video/mp4')),
  consent_version text NOT NULL,
  status text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','finalizing','ready','incomplete','failed','deleted')),
  object_key text,
  object_bytes bigint CHECK (object_bytes > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX service_recordings_interview_idx ON service_recordings(interview_id);
-- A chunk row is written when its upload link is issued and confirmed once S3 holds the object, so gaps are visible.
CREATE TABLE service_recording_chunks (
  recording_id text NOT NULL REFERENCES service_recordings(id),
  sequence integer NOT NULL CHECK (sequence BETWEEN 0 AND 99999),
  object_key text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  bytes bigint CHECK (bytes > 0),
  PRIMARY KEY (recording_id, sequence),
  CHECK ((confirmed_at IS NULL) = (bytes IS NULL))
);
