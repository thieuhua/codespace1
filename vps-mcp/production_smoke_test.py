"""Source-only checks by default. Exact release verification is explicit and offline."""
import argparse
import ast
import hashlib
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / 'tests' / 'fixtures'


def verify_release(release, manifest):
    """Compare an explicitly selected release to its recorded hashes.

    A newer checkout may differ; this never excuses a modified release.
    The default test mode never probes a production installation.
    """
    expected = json.loads(Path(manifest).read_text(encoding='utf-8'))
    differences = []
    for name in ('gateway.py', 'worker.py', 'broker.py'):
        digest = hashlib.sha256((Path(release) / name).read_bytes()).hexdigest()
        if digest != expected[name]:
            raise AssertionError(f'Released {name} does not match selected manifest')
        if hashlib.sha256((HERE / name).read_bytes()).hexdigest() != digest:
            differences.append(name)
    return differences


class ProductionSourceTests(unittest.TestCase):
    def test_source_syntax_and_baseline_integrity(self):
        fixture = json.loads((FIXTURES / 'production_source.json').read_text())
        for name in ('gateway.py', 'worker.py', 'broker.py'):
            with self.subTest(name=name):
                source = (HERE / name).read_bytes()
                ast.parse(source, filename=name)
        for path, digest in fixture['unchanged_sha256'].items():
            self.assertEqual(hashlib.sha256((HERE.parent / path).read_bytes().replace(b'\r\n', b'\n')).hexdigest(), digest, path)
        tree = ast.parse((HERE / 'gateway.py').read_bytes())
        definitions = {n.name: ast.dump(n, include_attributes=False) for n in tree.body if isinstance(n, ast.FunctionDef)}
        for name, original in fixture['gateway_functions'].items():
            self.assertEqual(definitions[name], original, name)
        base_tools = set(json.loads((FIXTURES / 'production_tools.json').read_text()))
        registered = {n.name for n in tree.body if isinstance(n, ast.FunctionDef) and n.decorator_list}
        self.assertEqual(base_tools, registered)
        core = ast.parse((HERE / 'mailbox_core' / 'tools.py').read_bytes())
        added = {n.name for n in ast.walk(core) if isinstance(n, ast.AsyncFunctionDef) and n.decorator_list}
        required = {'session_open', 'session_get', 'session_list', 'session_renew', 'session_close',
                    'list_recent_activity', 'mailbox_create', 'mailbox_list', 'mailbox_send',
                    'mailbox_receive', 'mailbox_ack', 'mailbox_reply', 'mailbox_get_message'}
        self.assertEqual(required, added)
        self.assertFalse(base_tools & added)

    def test_worker_separation(self):
        source = (HERE / 'worker.py').read_text()
        self.assertIn('SO_PEERCRED', source)
        self.assertIn('mcp-dev', source)
        self.assertNotIn('mailbox_core', source)
        self.assertNotIn('mailbox_core', (HERE / 'broker.py').read_text())

    def test_service_unit_definitions(self):
        root = HERE / 'deploy' / 'production'
        for name in ('vps-mcp.service', 'vps-mcp-dev.service', 'vps-mcp-approval.service'):
            with self.subTest(name=name):
                source = (root / name).read_text()
                self.assertIn('[Service]', source)
                self.assertIn('NoNewPrivileges=yes', source)
                self.assertNotIn('PRIVATE KEY', source)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--manifest', type=Path)
    args, remaining = parser.parse_known_args()
    if bool(args.release_dir) != bool(args.manifest):
        parser.error('--release-dir and --manifest must be supplied together')
    if args.release_dir:
        differences = verify_release(args.release_dir, args.manifest)
        print('PASS: selected release exactly matches manifest')
        if differences:
            print('EXPECTED candidate-versus-released source differences: ' + ', '.join(differences))
    unittest.main(argv=[__file__, *remaining])
