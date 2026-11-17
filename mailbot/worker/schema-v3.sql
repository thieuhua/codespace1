-- Chạy MỘT lần sau schema-v2.sql; SQLite không có ADD COLUMN IF NOT EXISTS.
-- message_id = 0 dành cho job không xuất phát từ thư (đợt sau).
-- status có thêm cancelled; schema-v2 không đặt CHECK constraint cho status.
ALTER TABLE jobs ADD COLUMN options_json TEXT;
ALTER TABLE jobs ADD COLUMN project TEXT;
ALTER TABLE jobs ADD COLUMN parent_id INTEGER;
ALTER TABLE jobs ADD COLUMN root_id INTEGER;
ALTER TABLE jobs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN job_token_hash TEXT;
ALTER TABLE jobs ADD COLUMN notify_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN delegate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN outbox_json TEXT;
ALTER TABLE jobs ADD COLUMN reply_to TEXT;
ALTER TABLE threads ADD COLUMN project TEXT;
