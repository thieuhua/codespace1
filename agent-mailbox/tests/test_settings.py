import tempfile
import unittest
from pathlib import Path
from agent_mailbox.core.settings import Settings


class SettingsTests(unittest.TestCase):
    def test_isolated_and_validated(self):
        with tempfile.TemporaryDirectory() as root:
            s = Settings(Path(root) / "state.db")
            self.assertTrue(s.db_path.is_absolute())
            for options in ({"max_wait_seconds": 21}, {"max_messages": 0}, {"max_ttl": True}):
                with self.assertRaises(ValueError):
                    Settings(s.db_path, **options)
