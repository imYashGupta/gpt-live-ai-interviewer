-- A recording job joins an attempt's uploaded chunks into one file once its upload window has closed.
ALTER TABLE service_jobs DROP CONSTRAINT service_jobs_kind_check;
ALTER TABLE service_jobs ADD CONSTRAINT service_jobs_kind_check CHECK (kind IN ('execute','assess','deliver','delete','recording'));
CREATE INDEX service_recordings_open_idx ON service_recordings(attempt_id) WHERE status IN ('recording','finalizing');
