CREATE TABLE principals (
    principal_id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE logical_sessions (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL REFERENCES principals(principal_id),
    name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','closed')),
    created_at REAL NOT NULL, expires_at REAL NOT NULL, last_seen REAL NOT NULL,
    closed_at REAL
);
CREATE INDEX sessions_owner ON logical_sessions(owner, ordinal);
CREATE TABLE session_acl (
    session_id TEXT NOT NULL REFERENCES logical_sessions(session_id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    PRIMARY KEY(session_id, principal_id)
);
CREATE INDEX acl_principal ON session_acl(principal_id, session_id);
CREATE TABLE mailboxes (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES logical_sessions(session_id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at REAL NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mailbox_session ON mailboxes(session_id, ordinal);
CREATE TABLE messages (
    message_id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL REFERENCES mailboxes(mailbox_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL, sender TEXT NOT NULL REFERENCES principals(principal_id),
    text TEXT NOT NULL, text_bytes INTEGER NOT NULL,
    correlation_id TEXT, in_reply_to TEXT, sent_at REAL NOT NULL,
    UNIQUE(mailbox_id, sequence)
);
CREATE INDEX message_retention ON messages(sent_at);
CREATE TABLE deliveries (
    message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    acknowledged_at REAL NOT NULL, PRIMARY KEY(message_id, principal_id)
);
CREATE TABLE idempotency_keys (
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    scope TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
    payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, session_id TEXT NOT NULL
        REFERENCES logical_sessions(session_id) ON DELETE CASCADE,
    PRIMARY KEY(principal_id, scope, operation, key)
);
CREATE TABLE rate_limits (
    principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id),
    window INTEGER NOT NULL, count INTEGER NOT NULL
);
CREATE TABLE audit (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL,
    session_id TEXT NOT NULL, operation TEXT NOT NULL, resource_id TEXT NOT NULL, at REAL NOT NULL
);
CREATE INDEX audit_session ON audit(session_id, event_id);
