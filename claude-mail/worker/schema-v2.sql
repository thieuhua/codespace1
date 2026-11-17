-- v2: mailbot — thư từ người trong whitelist thành job chạy CLI trên laptop.
CREATE TABLE IF NOT EXISTS allowlist (
  address TEXT NOT NULL,          -- địa chỉ người gửi, chữ thường
  agent TEXT NOT NULL DEFAULT '*', -- claude | codex | agy | *
  added_at TEXT NOT NULL,
  PRIMARY KEY (address, agent)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,     -- messages.id
  agent TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT,
  prompt TEXT NOT NULL,
  rfc_message_id TEXT,             -- Message-ID của thư yêu cầu
  references_hdr TEXT,
  thread_key TEXT NOT NULL,        -- Message-ID gốc của chuỗi thư
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | rate_limited
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  exit_ok INTEGER,
  output TEXT,
  session_id TEXT,
  reply_status TEXT,               -- sent | error
  reply_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs (status, agent, id);
CREATE INDEX IF NOT EXISTS idx_jobs_sender ON jobs (sender, created_at);

CREATE TABLE IF NOT EXISTS threads (
  thread_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_key, agent)
);
