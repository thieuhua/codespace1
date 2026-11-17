-- Command replies need a durable, atomic budget even though they create no jobs.
CREATE TABLE IF NOT EXISTS command_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_receipts_sender ON command_receipts(sender, created_at);
