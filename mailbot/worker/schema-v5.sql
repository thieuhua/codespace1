-- Apply ONCE after v4. Old jobs/threads remain read-only historical data.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creation_key TEXT UNIQUE,
  root_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  spawn_run_id INTEGER,
  depth INTEGER NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 2),
  agent TEXT NOT NULL CHECK(agent IN ('claude','codex','agy')),
  owner TEXT NOT NULL,
  project TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','waiting','done','failed','cancelled')),
  deliver TEXT NOT NULL CHECK(deliver IN ('email','parent')),
  session_id TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  wait_json TEXT,
  wait_until TEXT,
  rfc_message_id TEXT NOT NULL,
  references_hdr TEXT NOT NULL DEFAULT '',
  run_count INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER NOT NULL DEFAULT 8,
  child_count INTEGER NOT NULL DEFAULT 0,
  tree_count INTEGER NOT NULL DEFAULT 1,
  mail_count INTEGER NOT NULL DEFAULT 0,
  lost_count INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  completion_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_tasks_owner ON tasks(owner, id);
CREATE INDEX idx_tasks_root ON tasks(root_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_id, spawn_run_id);
CREATE INDEX idx_tasks_timer ON tasks(status, wait_until);
CREATE INDEX idx_tasks_expires ON tasks(status, expires_at);
CREATE INDEX idx_tasks_rfc ON tasks(owner, agent, rfc_message_id);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  schedule_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  token_hash TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  session_id TEXT,
  outcome_json TEXT NOT NULL DEFAULT '{"spawned":[],"notifications":[]}',
  outbox_json TEXT NOT NULL DEFAULT '[]',
  result_hash TEXT,
  finish_key TEXT,
  notify_count INTEGER NOT NULL DEFAULT 0,
  boundary TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_runs_live ON runs(task_id) WHERE status IN ('pending','running');
CREATE INDEX idx_runs_queue ON runs(status, id);
CREATE INDEX idx_runs_stale ON runs(status, claimed_at);
CREATE INDEX idx_runs_budget ON runs(created_at, task_id);
CREATE UNIQUE INDEX idx_runs_token ON runs(token_hash) WHERE token_hash IS NOT NULL;
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('start','mail','child_result','timer','run_lost')),
  message_id INTEGER,
  rfc_message_id TEXT,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_queue ON events(task_id, run_id, id);
CREATE INDEX idx_events_message ON events(message_id, run_id);
CREATE INDEX idx_events_rfc ON events(rfc_message_id, task_id);
CREATE TABLE outbound_mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','error')),
  text TEXT NOT NULL,
  subject TEXT NOT NULL,
  in_reply_to TEXT NOT NULL,
  references_hdr TEXT NOT NULL,
  outbox_json TEXT NOT NULL DEFAULT '[]',
  send_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_outbound_task ON outbound_mails(task_id, id);
CREATE INDEX idx_outbound_queue ON outbound_mails(status, id);
-- Counters change only after successful INSERT, inside the same D1 transaction.
CREATE TRIGGER tasks_child_count AFTER INSERT ON tasks WHEN NEW.parent_id IS NOT NULL BEGIN
  UPDATE tasks SET child_count = child_count + 1 WHERE id = NEW.parent_id;
  UPDATE tasks SET tree_count = tree_count + 1 WHERE id = NEW.root_id;
END;
CREATE TRIGGER tasks_root AFTER INSERT ON tasks WHEN NEW.parent_id IS NULL BEGIN
  UPDATE tasks SET root_id=id WHERE id=NEW.id;
END;
CREATE TRIGGER outbound_mail_count AFTER INSERT ON outbound_mails BEGIN
  UPDATE tasks SET mail_count = mail_count + 1 WHERE id = NEW.task_id;
END;
