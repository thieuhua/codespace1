-- Apply after v6, before enabling the QA sink Worker.
CREATE TABLE qa_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_key TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Full MIME can exceed D1's per-row limit when attachments are present.
CREATE TABLE qa_outbox_parts (
  mail_id INTEGER NOT NULL REFERENCES qa_outbox(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (mail_id, part)
);
