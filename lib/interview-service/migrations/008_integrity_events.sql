-- Browser-reported signals during a live attempt (tab hidden, window focus lost, camera stopped). offset_ms is measured
-- by the candidate's browser from the start of the attempt; received_at is the server's own clock.
CREATE TABLE service_integrity_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES service_attempts(id),
  type text NOT NULL CHECK (type IN ('tab_hidden','tab_visible','window_blur','window_focus','camera_lost','recording_unavailable')),
  offset_ms integer NOT NULL CHECK (offset_ms BETWEEN 0 AND 7200000),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_integrity_events_attempt_idx ON service_integrity_events(attempt_id, offset_ms, id);
