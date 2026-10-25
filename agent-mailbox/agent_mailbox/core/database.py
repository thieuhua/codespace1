"""SQLite WAL, versioned atomic migrations, bounded locks and private paths."""
from contextlib import contextmanager, closing
import os
from pathlib import Path
import sqlite3
import stat
from .errors import GatewayError
from .settings import Settings


class Database:
    def __init__(self, settings: Settings):
        self.settings = settings
        path = settings.db_path
        self._check_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._check_path()
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(fd)
        with closing(self._connect()) as db:
            if db.execute("PRAGMA page_size").fetchone()[0] != 4096:
                raise GatewayError("INTERNAL", "Unsupported database page size")
            db.execute("PRAGMA journal_mode=WAL")
            with self._transaction(db, write=True):
                version = db.execute("PRAGMA user_version").fetchone()[0]
                if version > 1:
                    raise GatewayError("INTERNAL", "Unsupported database version")
                if version == 0:
                    sql = Path(__file__).with_name("migrations").joinpath("001_initial.sql").read_text()
                    # No executescript: it implicitly commits an existing transaction.
                    for statement in sql.split(";"):
                        if statement.strip():
                            db.execute(statement)
                    db.execute("PRAGMA user_version=1")

    def _check_path(self):
        path = self.settings.db_path
        for parent in (path, *path.parents):
            try:
                metadata = parent.lstat()
            except FileNotFoundError:
                continue
            if (stat.S_ISLNK(metadata.st_mode)
                    or getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
                raise ValueError("State path must not contain symlinks or reparse points")
        for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
            try:
                metadata = candidate.lstat()
            except FileNotFoundError:
                # SQLite removes idle WAL/SHM files when the last connection closes.
                continue
            except PermissionError:
                if candidate == path:
                    raise
                # NTFS can deny stat while SQLite's last connection unlinks a
                # sidecar. Fail closed and let the caller retry the entire txn;
                # never skip link validation or misreport a bad credential.
                raise GatewayError("RESOURCE_EXHAUSTED", "Storage busy or full; retry later") from None
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink > 1
                    or getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
                raise ValueError("State files must not be linked")

    def _connect(self):
        self._check_path()
        db = sqlite3.connect(self.settings.db_path, timeout=self.settings.busy_timeout_ms / 1000,
                             isolation_level=None)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA cache_size=-2048")
            db.execute("PRAGMA wal_autocheckpoint=256")
            db.execute(f"PRAGMA max_page_count={self.settings.max_db_pages}")
        except BaseException:
            db.close()
            raise
        return db

    @contextmanager
    def _transaction(self, db, *, write=False):
        try:
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.commit()
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise

    @contextmanager
    def transaction(self, *, write=False):
        try:
            with closing(self._connect()) as db, self._transaction(db, write=write):
                yield db
        except sqlite3.Error as exc:
            code = getattr(exc, "sqlite_errorcode", 0) & 255
            if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_FULL):
                raise GatewayError("RESOURCE_EXHAUSTED", "Storage busy or full; retry later") from None
            raise GatewayError("INTERNAL", "Storage operation failed") from None

    def checkpoint(self):
        """Offline/admin maintenance only, never during a polling wait."""
        with closing(self._connect()) as db:
            return tuple(db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone())
