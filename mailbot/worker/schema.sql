CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  from_addr TEXT,
  from_name TEXT,
  to_json TEXT,
  cc_json TEXT,
  reply_to TEXT,
  subject TEXT,
  date TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  text TEXT,
  html TEXT,
  auth_results TEXT,
  raw_size INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (is_read, id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_b64 TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);
