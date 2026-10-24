"""Validated local storage limits. Identity cannot be selected by environment."""
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    db_path: Path
    busy_timeout_ms: int = 1000
    default_ttl: int = 86400
    max_ttl: int = 604800
    max_sessions: int = 100
    max_mailboxes: int = 20
    max_messages: int = 10000
    max_mailbox_bytes: int = 8 * 1024 * 1024
    max_text_bytes: int = 32768
    retention_seconds: int = 604800
    max_wait_seconds: int = 20
    max_waiters: int = 32
    writes_per_minute: int = 120
    max_audit: int = 10000
    max_keys: int = 20000
    max_db_pages: int = 32768  # 128 MiB at the required 4096-byte page size

    def __post_init__(self):
        object.__setattr__(self, "db_path", Path(self.db_path).absolute())
        for name, value in vars(self).items():
            if name != "db_path" and (type(value) is not int or value < 1):
                raise ValueError(f"{name} must be a positive integer")
        if self.default_ttl > self.max_ttl or self.max_wait_seconds > 20:
            raise ValueError("invalid TTL or wait limit")

