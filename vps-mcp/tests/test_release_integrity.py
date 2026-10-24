import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from production_smoke_test import verify_release


class ReleaseIntegrityTests(unittest.TestCase):
    def test_explicit_release_manifest_accepts_candidate_difference_but_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = {}
            for name in ("gateway.py", "worker.py", "broker.py"):
                source = b"# isolated old release\n"
                (root / name).write_bytes(source)
                manifest[name] = hashlib.sha256(source).hexdigest()
            path = root / "manifest.json"
            path.write_text(json.dumps(manifest))
            self.assertEqual(verify_release(root, path), ["gateway.py", "worker.py", "broker.py"])
            (root / "gateway.py").write_bytes(b"# tampered\n")
            with self.assertRaisesRegex(AssertionError, "does not match"):
                verify_release(root, path)
