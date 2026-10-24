from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from mailbox_core.database import Database
from mailbox_core.sessions import SessionService
from tests.support import ServiceCase, retry_storage_busy


class SessionTests(ServiceCase):
    def test_auth_acl_owner_and_restart(self):
        self.assert_code("UNAUTHENTICATED", self.sessions.open)
        with self.as_user():
            s = self.sessions.open("work", idempotency_key="open")
            self.assertEqual(s, self.sessions.open("work", idempotency_key="open"))
            self.assert_code("CONFLICT", self.sessions.open, "changed", idempotency_key="open")
        sid = s["session_id"]
        with self.as_user("C"):
            self.assert_code("NOT_FOUND", self.sessions.get, sid)
            self.assertEqual(self.sessions.list()["sessions"], [])
        self.admin.grant(sid, "B")
        with self.as_user("B"):
            self.assertEqual(self.sessions.get(sid)["session_id"], sid)
            self.assert_code("FORBIDDEN", self.sessions.close, sid)
            self.assert_code("FORBIDDEN", self.sessions.renew, sid)
        restarted = SessionService(Database(self.settings), clock=lambda: self.now[0])
        with self.as_user():
            self.assertEqual(restarted.get(sid)["status"], "active")
            self.assertEqual(restarted.close(sid), restarted.close(sid))
            self.assert_code("CONFLICT", restarted.renew, sid)
        self.admin.revoke(sid, "B")
        with self.as_user("B"):
            self.assert_code("NOT_FOUND", restarted.get, sid)

    def test_expiry_quota_pagination_validation(self):
        with self.as_user():
            a = self.sessions.open(ttl_seconds=1)
            self.sessions.open()
            page = self.sessions.list(limit=1)
            other = self.sessions.list(page["next_cursor"], limit=1)
            self.assertNotEqual(page["sessions"][0], other["sessions"][0])
            self.now[0] += 2
            self.assertEqual(self.sessions.get(a["session_id"])["status"], "expired")
            self.assert_code("EXPIRED", self.sessions.renew, a["session_id"])
            for bad in (0, -1, True, 0.5, 604801):
                self.assert_code("INVALID_ARGUMENT", self.sessions.open, ttl_seconds=bad)
            capped = SessionService(Database(replace(self.settings, max_sessions=2)))
            self.assert_code("RESOURCE_EXHAUSTED", capped.open)
            self.assert_code("INVALID_ARGUMENT", self.sessions.list, "not-a-cursor")
        with self.as_user("B"):
            self.assert_code("INVALID_ARGUMENT", self.sessions.list, page["next_cursor"])

    def test_concurrent_create_and_close(self):
        def create(_):
            with self.as_user():
                return retry_storage_busy(self.sessions.open, idempotency_key="concurrent")[0]["session_id"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(create, range(16)))
        self.assertEqual(len(set(ids)), 1)
        def close(_):
            with self.as_user():
                return retry_storage_busy(self.sessions.close, ids[0])[0]["status"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(close, range(16))), ["closed"] * 16)

    def test_unknown_and_disabled_principal(self):
        with self.as_user("forged"):
            self.assert_code("UNAUTHENTICATED", self.sessions.open)
        self.admin.disable("A")
        with self.as_user():
            self.assert_code("UNAUTHENTICATED", self.sessions.list)
