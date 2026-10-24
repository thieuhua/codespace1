from pathlib import Path
import tempfile
import time
import unittest
from agent_mailbox.core.admin import Provisioner
from agent_mailbox.core.database import Database
from agent_mailbox.core.errors import GatewayError
from agent_mailbox.core.identity import Principal, trusted_identity
from agent_mailbox.core.sessions import SessionService
from agent_mailbox.core.settings import Settings


def retry_storage_busy(fn, *args, **kwargs):
    """Retry transient SQLite contention with the same idempotent arguments."""
    for retry in range(10):
        try:
            return fn(*args, **kwargs), retry
        except GatewayError as error:
            if (error.code != "RESOURCE_EXHAUSTED"
                    or error.message != "Storage busy or full; retry later" or retry == 9):
                raise
            time.sleep(min(0.01 * 2**retry, 0.25))


class ServiceCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = [1000000.0]
        self.settings = Settings(Path(self.temp.name) / "state.db")
        self.db = Database(self.settings)
        self.admin = Provisioner(self.db)
        for pid in ("A", "B", "C"):
            self.admin.principal(pid, f"Agent {pid}")
        self.sessions = SessionService(self.db, clock=lambda: self.now[0])

    def as_user(self, pid="A"):
        return trusted_identity(Principal(pid))

    def assert_code(self, code, fn, *args, **kwargs):
        from agent_mailbox.core.errors import GatewayError
        with self.assertRaises(GatewayError) as error:
            fn(*args, **kwargs)
        self.assertEqual(code, error.exception.code)
