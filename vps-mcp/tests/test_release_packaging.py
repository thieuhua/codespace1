import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_manifest", HERE / "deploy/production/release_manifest.py")
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)


class ReleasePackagingTests(unittest.TestCase):
    def test_manifest_covers_importable_runtime_and_migration_without_test_state(self):
        names = manifest.source_files(HERE)
        self.assertEqual(names[:3], ["gateway.py", "worker.py", "broker.py"])
        self.assertIn("mailbox_core/migrations/001_initial.sql", names)
        self.assertTrue(all(name.endswith((".py", ".sql")) for name in names))
        self.assertFalse(any("tests" in name or "__pycache__" in name for name in names))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in names:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(HERE / name, target)
            self.assertEqual(manifest.source_files(root), names)
            (root / "mailbox_core/migrations/001_initial.sql").unlink()
            with self.assertRaises(ValueError):
                manifest.source_files(root)

    def test_installer_only_changes_runtime_packaging(self):
        source = (HERE / "deploy/production/install.sh").read_text()
        self.assertIn('test "$(id -u)" -eq 0', source)
        self.assertIn('chown -R root:root "$release"', source)
        self.assertIn('chmod -R go-w "$release"', source)
        self.assertIn('systemctl daemon-reload', source)
        self.assertNotIn('systemctl restart', source)
        self.assertNotIn('systemctl start ', source)
        self.assertIn('sha256sum "${source_files[@]}"', source)
        self.assertIn('cmp -s "$src/$f" "$release/$f"', source)
