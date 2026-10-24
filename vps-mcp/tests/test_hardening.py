import asyncio
from contextlib import closing
from dataclasses import replace
import json
import os
from pathlib import Path
import random
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from unittest.mock import patch
from mailbox_core.common import cursor, offset
from mailbox_core.database import Database
from mailbox_core.errors import GatewayError
from mailbox_core.mailboxes import MailboxService
from mailbox_core.sessions import SessionService
from tests.test_production_contract import check
from tests.support import ServiceCase, retry_storage_busy


class HardeningTests(ServiceCase):
    def setUp(self):
        super().setUp()
        self.mail = MailboxService(self.db, clock=lambda: self.now[0])
        with self.as_user():
            self.sid = self.sessions.open()["session_id"]
            self.mid = self.mail.create(self.sid)["mailbox_id"]

    def test_process_commit_crash_recovery_and_replay(self):
        dbpath = Path(self.temp.name) / "process.db"
        worker = Path(__file__).with_name("process_worker.py")
        proc = subprocess.run([sys.executable, str(worker), "commit", str(dbpath)],
                              capture_output=True, text=True, timeout=15, check=True)
        result = json.loads(proc.stdout)
        crashed = subprocess.run([sys.executable, str(worker), "crash", str(dbpath)], timeout=15)
        self.assertEqual(crashed.returncode, 7)
        recovered = Database(replace(self.settings, db_path=dbpath))
        service = MailboxService(recovered)
        mid = result["mailbox"]["mailbox_id"]
        with self.as_user():
            page = asyncio.run(service.receive(mid))
            self.assertEqual(page["messages"][0]["text"], "durable")
            self.assertTrue(service.send(mid, "durable", idempotency_key="task")["duplicated"])
            self.assertEqual(service.send(mid, "after recovery")["sequence"], 2)
        with recovered.transaction() as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_busy_lock_is_bounded_and_fail_closed(self):
        short = MailboxService(Database(replace(self.settings, busy_timeout_ms=80)), clock=lambda: self.now[0])
        with closing(sqlite3.connect(self.settings.db_path, isolation_level=None)) as lock:
            lock.execute("BEGIN IMMEDIATE")
            with self.as_user():
                started = time.monotonic()
                self.assert_code("RESOURCE_EXHAUSTED", short.send, self.mid, "blocked")
                self.assertLess(time.monotonic() - started, 0.8)
                # WAL reads still work while another process holds the write lock.
                self.assertEqual(asyncio.run(short.receive(self.mid))["messages"], [])
            lock.rollback()
        with self.as_user():
            self.assertEqual(short.send(self.mid, "after unlock")["sequence"], 1)

    def test_client_retries_storage_contention_without_retrying_quota_errors(self):
        short = MailboxService(Database(replace(self.settings, busy_timeout_ms=40, max_messages=1)),
                               clock=lambda: self.now[0])
        with closing(sqlite3.connect(self.settings.db_path, isolation_level=None)) as lock:
            lock.execute("BEGIN IMMEDIATE")
            with self.as_user(), patch("tests.support.time.sleep", side_effect=lambda _: lock.rollback()):
                sent, retries = retry_storage_busy(short.send, self.mid, "once", idempotency_key="retry")
            self.assertEqual(retries, 1)
        with self.as_user(), patch("tests.support.time.sleep", side_effect=AssertionError("Unexpected retry")):
            replay, retries = retry_storage_busy(short.send, self.mid, "once", idempotency_key="retry")
            self.assertEqual(replay["message_id"], sent["message_id"])
            self.assertTrue(replay["duplicated"])
            self.assertEqual(retries, 0)
            self.assert_code("RESOURCE_EXHAUSTED", retry_storage_busy, short.send, self.mid, "full")
            self.assert_code("CONFLICT", retry_storage_busy, short.send, self.mid, "changed", idempotency_key="retry")
            self.assertEqual(len(asyncio.run(short.receive(self.mid))["messages"]), 1)

    def test_rate_key_byte_mailbox_quotas_and_cleanup(self):
        with self.as_user():
            limited = MailboxService(Database(replace(self.settings, max_mailboxes=1)), clock=lambda: self.now[0])
            self.assert_code("RESOURCE_EXHAUSTED", limited.create, self.sid)
            byte_limit = MailboxService(Database(replace(self.settings, max_mailbox_bytes=3)), clock=lambda: self.now[0])
            self.assert_code("RESOURCE_EXHAUSTED", byte_limit.send, self.mid, "ềề")
            key_limit = MailboxService(Database(replace(self.settings, max_keys=1)), clock=lambda: self.now[0])
            first = key_limit.send(self.mid, "one", idempotency_key="one")
            self.assert_code("RESOURCE_EXHAUSTED", key_limit.send, self.mid, "two", idempotency_key="two")
            # Rejected keyed write rolls back sequence and message atomically.
            self.assertEqual(len(asyncio.run(key_limit.receive(self.mid))["messages"]), 1)
            capped = MailboxService(Database(replace(self.settings, writes_per_minute=1)), clock=lambda: self.now[0])
            self.assert_code("RESOURCE_EXHAUSTED", capped.send, self.mid, "limited")
            self.now[0] += 60
            self.assertEqual(capped.send(self.mid, "next minute")["sequence"], 2)
            self.assert_code("RESOURCE_EXHAUSTED", capped.ack, self.mid, first["message_id"])
            self.sessions.close(self.sid)
            self.now[0] += self.settings.retention_seconds + 1
            self.admin.cleanup(now=self.now[0])
            self.assertEqual(self.mail.list()["mailboxes"], [])
            with self.db.transaction() as db:
                for table in ("messages", "deliveries", "idempotency_keys", "session_acl"):
                    self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)

    def test_waiter_capacity_and_close_during_wait(self):
        mail = MailboxService(Database(replace(self.settings, max_waiters=1)), clock=lambda: self.now[0])
        async def scenario():
            with self.as_user():
                task = asyncio.create_task(mail.receive(self.mid, wait_seconds=2))
                for _ in range(100):
                    if mail._waiters:
                        break
                    await asyncio.sleep(0.01)
                with self.assertRaises(GatewayError) as error:
                    await mail.receive(self.mid, wait_seconds=1)
                self.assertEqual(error.exception.code, "RESOURCE_EXHAUSTED")
                self.sessions.close(self.sid)
                with self.assertRaises(GatewayError) as error:
                    await task
                self.assertEqual(error.exception.code, "CONFLICT")
                self.assertEqual(mail._waiters, 0)
        asyncio.run(scenario())

    def test_db_worker_admission_and_queued_cancellation_release_capacity(self):
        from mailbox_core.async_db import run_db
        ready = threading.Event()
        async def scenario():
            tasks = [asyncio.create_task(run_db(ready.wait, 3)) for _ in range(64)]
            try:
                await asyncio.sleep(0.05)
                with self.assertRaises(GatewayError) as error:
                    await run_db(lambda: None)
                self.assertEqual(error.exception.code, "RESOURCE_EXHAUSTED")
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            finally:
                ready.set()
                await asyncio.gather(*tasks, return_exceptions=True)
            self.assertEqual(await run_db(lambda: "ready"), "ready")
        asyncio.run(scenario())

    def test_sql_injection_cursor_fuzz_no_cross_session_access(self):
        rng = random.Random(42)
        with self.as_user():
            attack = "' OR 1=1; DROP TABLE messages;--"
            self.assert_code("NOT_FOUND", self.mail.send, attack, "attack")
            other = self.sessions.open(attack)["session_id"]
            self.assertEqual(self.sessions.get(other)["name"], attack)
            for _ in range(100):
                token = "!" + "".join(rng.choice("abCD0123_=-[]") for _ in range(rng.randrange(1, 300)))
                self.assert_code("INVALID_ARGUMENT", offset, token, "messages:test")
            for value in (0, 1, 999999, 2**63 - 1):
                self.assertEqual(offset(cursor("scope", value), "scope"), value)

    def test_migration_idempotence_future_version_and_atomic_failure(self):
        for _ in range(3):
            Database(self.settings)
        with self.db.transaction(write=True) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            db.execute("PRAGMA user_version=2")
        self.assert_code("INTERNAL", Database, self.settings)
        broken = replace(self.settings, db_path=Path(self.temp.name) / "broken.db")
        with patch.object(Path, "read_text", return_value="CREATE TABLE half_done (id INTEGER); INVALID SQL;"):
            with self.assertRaises(sqlite3.Error):
                Database(broken)
        with closing(sqlite3.connect(broken.db_path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE name='half_done'").fetchall(), [])
        Database(broken)

    def test_hardlink_state_rejected(self):
        link = Path(self.temp.name) / "linked.db"
        os.link(self.settings.db_path, link)
        with self.assertRaises(ValueError):
            Database(replace(self.settings, db_path=link))
        link.unlink()

    def test_database_page_quota_rolls_back_failed_append(self):
        small = replace(self.settings, db_path=Path(self.temp.name) / "small.db", max_db_pages=64)
        db = Database(small)
        from mailbox_core.admin import Provisioner
        Provisioner(db).principal("A", "A")
        mail = MailboxService(db)
        with self.as_user():
            sid = SessionService(db).open()["session_id"]
            mid = mail.create(sid)["mailbox_id"]
            committed = 0
            for _ in range(16):
                try:
                    mail.send(mid, "x" * 32768)
                    committed += 1
                except GatewayError as error:
                    self.assertEqual(error.code, "RESOURCE_EXHAUSTED")
                    break
            else:
                self.fail("Expected SQLite page quota to reject append")
            page = asyncio.run(mail.receive(mid))
            self.assertEqual([r["sequence"] for r in page["messages"]], list(range(1, committed + 1)))
            with db.transaction() as conn:
                self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertLessEqual(conn.execute("PRAGMA page_count").fetchone()[0], 64)

    def test_symlink_state_rejected_when_supported(self):
        link = Path(self.temp.name) / "symlink.db"
        try:
            link.symlink_to(self.settings.db_path)
        except OSError:
            self.skipTest("OS does not permit unprivileged symlink creation")
        with self.assertRaises(ValueError):
            Database(replace(self.settings, db_path=link))
        link.unlink()
        directory_link = Path(self.temp.name) / "linked-directory"
        directory_link.symlink_to(Path(self.temp.name), target_is_directory=True)
        try:
            through_link = directory_link / "must-not-create" / "db.sqlite3"
            with self.assertRaises(ValueError):
                Database(replace(self.settings, db_path=through_link))
            self.assertFalse((Path(self.temp.name) / "must-not-create").exists())
        finally:
            directory_link.unlink()

    def test_audit_cap_and_no_payload(self):
        capped = MailboxService(Database(replace(self.settings, max_audit=3)), clock=lambda: self.now[0])
        with self.as_user():
            for i in range(10):
                capped.send(self.mid, "PRIVATE-MESSAGE", idempotency_key=str(i))
            activity = self.sessions.activity(self.sid, limit=2)
            self.assertTrue(activity["has_more"])
            self.assertEqual(len(self.sessions.activity(self.sid, activity["next_cursor"])["events"]), 1)
            self.assertNotIn("PRIVATE-MESSAGE", str(activity))
            with self.db.transaction() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM audit").fetchone()[0], 3)

    def test_smoke_never_connects_to_production_port(self):
        # Never bind the production port, even if apparently unused.
        original = socket.socket.connect
        def guarded_connect(sock, address):
            if isinstance(address, tuple) and address[1] == 8765:
                raise AssertionError("Test attempted to contact live 8765")
            return original(sock, address)
        with patch.object(socket.socket, "connect", guarded_connect):
            asyncio.run(check())
