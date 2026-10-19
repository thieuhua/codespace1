"""Unit tests for the approval-core state machine; no privileged actions."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from security.approval_core import ApprovalStore, ExecutionIntent


def sample_intent() -> ExecutionIntent:
    return ExecutionIntent(
        principal="verified:owner:thieuhua",
        operation="restart_service",
        target="combat-web.service",
        command="systemctl restart combat-web.service",
        cwd="/home/thieuhua/code/combat-analysis",
        timeout_seconds=30,
    )


class ApprovalCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.time = [1000.0]
        self.db_path = Path(self.temp.name) / "approvals.sqlite3"
        self.store = ApprovalStore(self.db_path, clock=lambda: self.time[0])
        self.intent = sample_intent()

    def test_pending_does_not_grant_permission(self):
        rid = self.store.create(self.intent)
        self.assertIsNotNone(self.store.get_request(rid))
        self.assertFalse(self.store.redeem(rid, "made-up-key", self.intent))

    def test_approve_one_use_exact_command(self):
        rid = self.store.create(self.intent)
        key = self.store.approve(rid, verified_approver="owner:thieuhua")
        self.assertIsNotNone(key)
        self.assertTrue(self.store.redeem(rid, key, self.intent))
        self.assertFalse(self.store.redeem(rid, key, self.intent))

    def test_mismatched_command_scope_or_principal_rejected_without_consuming(self):
        rid = self.store.create(self.intent)
        key = self.store.approve(rid, verified_approver="owner:thieuhua")
        for changed in (
            replace(self.intent, command="systemctl restart vps-mcp.service"),
            replace(self.intent, target="vps-mcp.service"),
            replace(self.intent, cwd="/tmp"),
            replace(self.intent, timeout_seconds=60),
            replace(self.intent, principal="verified:owner:someone-else"),
        ):
            self.assertFalse(self.store.redeem(rid, key, changed))
        self.assertTrue(self.store.redeem(rid, key, self.intent))

    def test_denied_request_never_gets_key(self):
        rid = self.store.create(self.intent)
        self.assertTrue(self.store.deny(rid, verified_approver="owner:thieuhua"))
        self.assertIsNone(self.store.approve(rid, verified_approver="owner:thieuhua"))
        self.assertFalse(self.store.deny(rid, verified_approver="owner:thieuhua"))

    def test_pending_request_expires(self):
        rid = self.store.create(self.intent)
        self.time[0] += 301
        self.assertIsNone(self.store.approve(rid, verified_approver="owner:thieuhua"))

    def test_granted_key_expires(self):
        rid = self.store.create(self.intent)
        key = self.store.approve(rid, verified_approver="owner:thieuhua")
        self.time[0] += 91
        self.assertFalse(self.store.redeem(rid, key, self.intent))

    def test_wrong_key_cannot_consume_valid_approval(self):
        rid = self.store.create(self.intent)
        key = self.store.approve(rid, verified_approver="owner:thieuhua")
        self.assertFalse(self.store.redeem(rid, "invalid", self.intent))
        self.assertTrue(self.store.redeem(rid, key, self.intent))

    def test_token_not_stored_as_plaintext(self):
        rid = self.store.create(self.intent)
        key = self.store.approve(rid, verified_approver="owner:thieuhua")
        with sqlite3.connect(self.db_path) as db:
            token_digest = db.execute("SELECT token_digest FROM approvals WHERE id=?", (rid,)).fetchone()[0]
        self.assertNotEqual(key, token_digest)
        self.assertEqual(len(token_digest), 64)

    def test_concurrent_redeem_allows_only_one(self):
        rid = self.store.create(self.intent)
        key = self.store.approve(rid, verified_approver="owner:thieuhua")
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.store.redeem(rid, key, self.intent), range(8)))
        self.assertEqual(sum(results), 1)

    def test_malformed_intent_rejected(self):
        with self.assertRaises(ValueError):
            replace(self.intent, command="bad" + chr(0) + "command")
        with self.assertRaises(ValueError):
            replace(self.intent, timeout_seconds=91)
        with self.assertRaises(ValueError):
            replace(self.intent, command="x" * 8193)


if __name__ == "__main__":
    unittest.main()
