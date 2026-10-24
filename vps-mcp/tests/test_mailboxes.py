import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from mailbox_core.database import Database
from mailbox_core.mailboxes import MailboxService
from tests.support import ServiceCase


class MailboxTests(ServiceCase):
    def setUp(self):
        super().setUp()
        self.mail = MailboxService(self.db, clock=lambda: self.now[0])
        with self.as_user():
            self.sid = self.sessions.open()["session_id"]
            self.mid = self.mail.create(self.sid, "inbox", idempotency_key="box")["mailbox_id"]
        self.admin.grant(self.sid, "B")

    def receive(self, **kwargs):
        return asyncio.run(self.mail.receive(self.mid, **kwargs))

    def test_restart_reply_ack_and_acl(self):
        with self.as_user():
            sent = self.mail.send(self.mid, "dispatch", idempotency_key="task")
            self.assertEqual(self.mid, self.mail.create(self.sid, "inbox", idempotency_key="box")["mailbox_id"])
        restarted = MailboxService(Database(self.settings), clock=lambda: self.now[0])
        with self.as_user("B"):
            page = asyncio.run(restarted.receive(self.mid))
            self.assertEqual(page["messages"][0]["text"], "dispatch")
            self.assertEqual(restarted.ack(self.mid, sent["message_id"]), restarted.ack(self.mid, sent["message_id"]))
            self.assertTrue(restarted.get_message(self.mid, sent["message_id"])["acknowledged"])
            reply = restarted.reply(self.mid, sent["message_id"], "done", idempotency_key="reply")
            self.assertEqual(reply["in_reply_to"], sent["message_id"])
            self.assert_code("FORBIDDEN", restarted.create, self.sid)
        with self.as_user():
            self.assertFalse(restarted.get_message(self.mid, sent["message_id"])["acknowledged"])
            self.assertEqual(len(asyncio.run(restarted.receive(self.mid))["messages"]), 2)
            self.assertEqual(len(restarted.list(self.sid)["mailboxes"]), 1)
        with self.as_user("C"):
            for fn, args in ((restarted.send, (self.mid, "guess")), (restarted.ack, (self.mid, sent["message_id"])),
                             (restarted.reply, (self.mid, sent["message_id"], "guess")),
                             (restarted.get_message, (self.mid, sent["message_id"])),
                             (restarted.list, (self.sid,))):
                self.assert_code("NOT_FOUND", fn, *args)
            self.assertEqual(restarted.list()["mailboxes"], [])
            self.assert_code("NOT_FOUND", self.receive)

    def test_concurrent_order_pagination_idempotency(self):
        def send(i):
            with self.as_user():
                return self.mail.send(self.mid, str(i), idempotency_key=str(i))
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(send, range(50)))
        self.assertEqual(sorted(r["sequence"] for r in results), list(range(1, 51)))
        self.assertEqual(len({r["message_id"] for r in results}), 50)
        with self.as_user():
            page, seen = {}, []
            while True:
                page = self.receive(after_cursor=page.get("next_cursor"), limit=7)
                seen.extend(r["sequence"] for r in page["messages"])
                if not page["has_more"]:
                    break
            self.assertEqual(seen, list(range(1, 51)))
            self.assertTrue(self.mail.send(self.mid, "0", idempotency_key="0")["duplicated"])
            self.assert_code("CONFLICT", self.mail.send, self.mid, "changed", idempotency_key="0")
        def duplicate(_):
            with self.as_user("B"):
                return self.mail.send(self.mid, "same", idempotency_key="same")
        with ThreadPoolExecutor(max_workers=8) as pool:
            dupes = list(pool.map(duplicate, range(16)))
        self.assertEqual(sum(not r["duplicated"] for r in dupes), 1)

    def test_validation_quota_retention_tombstones(self):
        capped = MailboxService(Database(replace(self.settings, max_messages=1)), clock=lambda: self.now[0])
        with self.as_user():
            for text in ("x" * 32769, "ề" * 11000, "\ud800", "bad\x00"):
                self.assert_code("INVALID_ARGUMENT", capped.send, self.mid, text)
            original = capped.send(self.mid, "payload", idempotency_key="keep")
            self.assert_code("RESOURCE_EXHAUSTED", capped.send, self.mid, "full")
            self.assertTrue(capped.send(self.mid, "payload", idempotency_key="keep")["duplicated"])
            self.now[0] += self.settings.retention_seconds + 1
            self.assertEqual(self.receive()["messages"], [])
            # Expired sessions permit history reads, but no send/renew/creation.
            self.assert_code("EXPIRED", capped.send, self.mid, "payload", idempotency_key="keep")
            self.admin.cleanup(now=self.now[0])
        # Separate long-lived session: retention cannot recreate an old key.
        self.now[0] = 1000000.0
        short = MailboxService(Database(replace(self.settings, retention_seconds=1)), clock=lambda: self.now[0])
        with self.as_user():
            other = self.mail.create(self.sid)["mailbox_id"]
            old = short.send(other, "keep", idempotency_key="old")
            self.now[0] += 2
            short.send(other, "new")
            replay = short.send(other, "keep", idempotency_key="old")
            self.assertEqual(old["message_id"], replay["message_id"])
            self.assertEqual([r["text"] for r in asyncio.run(short.receive(other))["messages"]], ["new"])

    def test_cross_mailbox_cursor_message_and_closure(self):
        with self.as_user():
            other = self.mail.create(self.sid)["mailbox_id"]
            sent = self.mail.send(other, "private")
            page = asyncio.run(self.mail.receive(other))
            self.assert_code("INVALID_ARGUMENT", self.receive, after_cursor=page["next_cursor"])
            self.assert_code("NOT_FOUND", self.mail.ack, self.mid, sent["message_id"])
            self.assert_code("NOT_FOUND", self.mail.reply, self.mid, sent["message_id"], "bad")
            self.sessions.close(self.sid)
            self.assert_code("CONFLICT", self.mail.send, other, "closed")
            self.assertEqual(len(asyncio.run(self.mail.receive(other))["messages"]), 1)
            self.assertTrue(self.mail.ack(other, sent["message_id"])["acknowledged"])

    def test_longpoll_delivery_timeout_cancel_expiry_and_revocation(self):
        async def scenario():
            with self.as_user("B"):
                task = asyncio.create_task(self.mail.receive(self.mid, wait_seconds=2))
            await asyncio.sleep(0.1)
            # A separate write succeeds while B waits (no DB lock held by polling).
            with self.as_user():
                await asyncio.to_thread(self.mail.send, self.mid, "wake")
            result = await task
            self.assertEqual(result["messages"][0]["text"], "wake")
            with self.as_user("B"):
                start = asyncio.get_running_loop().time()
                empty = await self.mail.receive(self.mid, result["next_cursor"], wait_seconds=0.1)
                self.assertEqual(empty["messages"], [])
                self.assertLess(asyncio.get_running_loop().time() - start, 1)
                task = asyncio.create_task(self.mail.receive(self.mid, result["next_cursor"], wait_seconds=20))
                await asyncio.sleep(0.05)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(self.mail._waiters, 0)
                task = asyncio.create_task(self.mail.receive(self.mid, result["next_cursor"], wait_seconds=1))
                await asyncio.sleep(0.05)
                self.admin.revoke(self.sid, "B")
                with self.assertRaises(Exception) as error:
                    await task
                self.assertEqual(error.exception.code, "NOT_FOUND")
            with self.as_user():
                task = asyncio.create_task(self.mail.receive(self.mid, result["next_cursor"], wait_seconds=1))
                await asyncio.sleep(0.05)
                self.now[0] += 86401
                with self.assertRaises(Exception) as error:
                    await task
                self.assertEqual(error.exception.code, "EXPIRED")
        asyncio.run(scenario())

    def test_wait_and_page_boundaries(self):
        with self.as_user():
            for wait in (-1, 21, float("nan"), float("inf"), True, "1"):
                self.assert_code("INVALID_ARGUMENT", self.receive, wait_seconds=wait)
            for limit in (0, 101, True, 1.5):
                self.assert_code("INVALID_ARGUMENT", self.receive, limit=limit)
            for token in ("' OR 1=1", "!", "A" * 513):
                self.assert_code("INVALID_ARGUMENT", self.receive, after_cursor=token)
