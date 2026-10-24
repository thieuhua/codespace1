from pathlib import Path
import tempfile
import unittest
from mailbox_core.admin import Provisioner
from mailbox_core.database import Database
from mailbox_core.identity import Principal, trusted_identity
from mailbox_core.sessions import SessionService
from mailbox_core.settings import Settings


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
        from mailbox_core.errors import GatewayError
        with self.assertRaises(GatewayError) as error:
            fn(*args, **kwargs)
        self.assertEqual(code, error.exception.code)
