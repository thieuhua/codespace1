"""Validate tracked production source without mutating the running services."""
import ast
import hashlib
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIVE = Path('/opt/vps-mcp/current')


class ProductionSourceTests(unittest.TestCase):
    def test_source_syntax_and_live_integrity(self):
        for name in ('gateway.py', 'worker.py', 'broker.py'):
            with self.subTest(name=name):
                source = (HERE / name).read_bytes()
                ast.parse(source, filename=name)
                if (LIVE / name).is_file():
                    self.assertEqual(
                        hashlib.sha256(source).digest(),
                        hashlib.sha256((LIVE / name).read_bytes()).digest(),
                        f'{name} differs from running production release',
                    )
        self.assertEqual((HERE / 'gateway.py').read_text().count('@mcp.tool()'), 16)

    def test_worker_separation(self):
        source = (HERE / 'worker.py').read_text()
        self.assertIn('SO_PEERCRED', source)
        self.assertIn('mcp-dev', source)

    def test_service_unit_definitions(self):
        root = HERE / 'deploy' / 'production'
        for name in ('vps-mcp.service', 'vps-mcp-dev.service', 'vps-mcp-approval.service'):
            with self.subTest(name=name):
                source = (root / name).read_text()
                self.assertIn('[Service]', source)
                self.assertIn('NoNewPrivileges=yes', source)
                self.assertNotIn('PRIVATE KEY', source)


if __name__ == '__main__':
    unittest.main()
