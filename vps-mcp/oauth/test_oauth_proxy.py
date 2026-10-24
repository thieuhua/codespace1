"""Tests for the OAuth front door. Run from this directory: python -m unittest -v test_oauth_proxy"""
import base64
from contextlib import closing, contextmanager, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import httpx
from starlette.testclient import TestClient

import oauth_proxy as op

CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback"
PASSWORD = "correct horse battery staple"


def windows_acl(script, **variables):
    # Windows PowerShell must not import PowerShell 7 modules inherited from CI.
    env = {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
         "$ErrorActionPreference = 'Stop'; " + script],
        env={**env, **variables}, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode:
        raise AssertionError(f"Windows fixture ACL command failed: {result.stderr.strip()} {result.stdout.strip()}")
    return result.stdout


@contextmanager
def private_tempdir():
    """Create private Windows fixtures instead of relying on POSIX mode bits."""
    with tempfile.TemporaryDirectory() as path:
        if os.name == "nt":
            script = r"""
            $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl = [System.Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                $user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
            Set-Acl -LiteralPath $env:VPS_MCP_TEST_PRIVATE_DIR -AclObject $acl
            """
            windows_acl(script, VPS_MCP_TEST_PRIVATE_DIR=path)
        yield path


def assert_private_file(test, path, mode):
    """Check POSIX permissions or the actual Windows DACL, never skip privacy."""
    if os.name != "nt":
        test.assertEqual(oct(os.stat(path).st_mode & 0o777), oct(mode))
        return
    script = r"""
    $acl = Get-Acl -LiteralPath $env:VPS_MCP_TEST_PRIVATE_FILE -ErrorAction Stop
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $entries = @($acl.Access | ForEach-Object {
        @{sid = $_.IdentityReference.Translate($sidType).Value;
          type = $_.AccessControlType.ToString(); rights = [int]$_.FileSystemRights}
    })
    @{user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      owner = $acl.GetOwner($sidType).Value; entries = $entries} | ConvertTo-Json -Depth 4 -Compress
    """
    acl = json.loads(windows_acl(script, VPS_MCP_TEST_PRIVATE_FILE=path))
    allowed = {acl["user"], "S-1-5-18", "S-1-5-32-544"}  # user, SYSTEM, Administrators
    test.assertIn(acl["owner"], allowed)
    grants = [entry for entry in acl["entries"] if entry["type"] == "Allow"]
    test.assertTrue(grants, "Private file must have an explicit non-null DACL")
    for grant in grants:
        test.assertIn(grant["sid"], allowed, "Private test state grants another account access")
    test.assertTrue(any(entry["sid"] == acl["user"] and entry["rights"] & 3 == 3 for entry in grants),
                    "The current user must retain read/write access")


class Harness:
    """Builds the app with injected fakes: in-memory store, fake gateway, controllable clock."""

    def __init__(self, **overrides):
        self.offset = 0.0
        self.clock = lambda: time.time() + self.offset
        self.settings = op.Settings(public_url="https://mcp.test", **overrides)
        self.store = op.Store(":memory:", self.clock)
        self.owner = op.OwnerCredentials.create(PASSWORD)
        self.limiter = op.FailureLimiter()
        self.upstream_requests = []
        self.upstream_error = None
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(self._gateway))
        self.app = op.build_app(self.settings, self.store, self.owner, self.limiter, self.http, self.clock)
        self.client = TestClient(self.app, base_url="https://mcp.test", follow_redirects=False)

    def _gateway(self, request: httpx.Request) -> httpx.Response:
        if self.upstream_error:
            raise self.upstream_error
        self.upstream_requests.append(request)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})

    def totp(self) -> str:
        return op.hotp(self.owner.totp_key, int(self.clock() // 30))

    def next_totp_step(self) -> None:
        self.offset += 31

    def register(self, redirect=CLAUDE_CB):
        r = self.client.post("/register", json={
            "redirect_uris": [redirect], "client_name": "Claude", "token_endpoint_auth_method": "client_secret_post",
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]})
        return r

    def authorize(self, info, verifier, **extra):
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        query = {"client_id": info["client_id"], "redirect_uri": CLAUDE_CB, "response_type": "code", "state": "st8",
                 "code_challenge": challenge, "code_challenge_method": "S256", "scope": "mcp",
                 "resource": "https://mcp.test/mcp", **extra}
        return self.client.get("/authorize", params=query)

    def approve(self, pending_url, password=PASSWORD, code=None, action="approve"):
        req = parse_qs(urlparse(pending_url).query)["req"][0]
        return self.client.post("/owner/approve", data={"req": req, "password": password,
                                                        "code": self.totp() if code is None else code, "action": action})

    def token(self, info, code, verifier):
        return self.client.post("/token", data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": CLAUDE_CB, "client_id": info["client_id"],
            "client_secret": info["client_secret"], "code_verifier": verifier})

    def refresh(self, info, refresh_token):
        return self.client.post("/token", data={"grant_type": "refresh_token", "refresh_token": refresh_token,
                                                "client_id": info["client_id"], "client_secret": info["client_secret"]})

    def full_login(self):
        info = self.register().json()
        verifier = secrets.token_urlsafe(48)
        location = self.authorize(info, verifier).headers["location"]
        redirect = self.approve(location).headers["location"]
        code = parse_qs(urlparse(redirect).query)["code"][0]
        tokens = self.token(info, code, verifier).json()
        return info, verifier, code, tokens

    def call_mcp(self, token, body=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return self.client.post("/mcp", json=body or {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                headers={**headers, "Accept": "application/json, text/event-stream"})


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness()

    def tearDown(self):
        self.h.client.close()

    def test_metadata_advertises_pkce_registration_and_resource(self):
        meta = self.h.client.get("/.well-known/oauth-authorization-server").json()
        self.assertEqual(meta["code_challenge_methods_supported"], ["S256"])
        self.assertEqual(meta["authorization_endpoint"], "https://mcp.test/authorize")
        self.assertEqual(meta["registration_endpoint"], "https://mcp.test/register")
        for path in ("/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"):
            res = self.h.client.get(path).json()
            self.assertEqual(res["resource"].rstrip("/"), "https://mcp.test/mcp")
            self.assertEqual([s.rstrip("/") for s in res["authorization_servers"]], ["https://mcp.test"])

    def test_unauthenticated_mcp_is_401_with_discovery_hint(self):
        r = self.h.call_mcp(None)
        self.assertEqual(r.status_code, 401)
        self.assertIn("/.well-known/oauth-protected-resource/mcp", r.headers["www-authenticate"])
        self.assertEqual(self.h.upstream_requests, [])

    def test_garbage_and_wrong_prefix_tokens_rejected(self):
        for token in ("x", "vmcp_at_" + secrets.token_urlsafe(32)):
            self.assertEqual(self.h.call_mcp(token).status_code, 401)

    def test_full_flow_reaches_gateway_without_credential(self):
        _, _, _, tokens = self.h.full_login()
        self.assertEqual(tokens["token_type"], "Bearer")
        r = self.h.call_mcp(tokens["access_token"])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["result"], {"tools": []})
        sent = self.h.upstream_requests[-1]
        self.assertEqual(str(sent.url), "http://127.0.0.1:8765/mcp")
        self.assertNotIn("authorization", sent.headers)
        self.assertEqual(sent.headers["host"], "127.0.0.1:8765")

    def test_tokens_are_not_stored_in_plaintext(self):
        _, _, code, tokens = self.h.full_login()
        dump = "\n".join(self.h.store.db.iterdump())
        for secret in (tokens["access_token"], tokens["refresh_token"], code):
            self.assertNotIn(secret, dump)

    def test_authorization_code_is_single_use(self):
        info = self.h.register().json()
        verifier = secrets.token_urlsafe(48)
        redirect = self.h.approve(self.h.authorize(info, verifier).headers["location"]).headers["location"]
        code = parse_qs(urlparse(redirect).query)["code"][0]
        self.assertEqual(self.h.token(info, code, verifier).status_code, 200)
        self.assertEqual(self.h.token(info, code, verifier).status_code, 400)

    def test_wrong_pkce_verifier_rejected(self):
        info = self.h.register().json()
        redirect = self.h.approve(self.h.authorize(info, secrets.token_urlsafe(48)).headers["location"]).headers["location"]
        code = parse_qs(urlparse(redirect).query)["code"][0]
        self.assertEqual(self.h.token(info, code, secrets.token_urlsafe(48)).status_code, 400)

    def test_refresh_rotates_and_reuse_revokes_session(self):
        info, _, _, tokens = self.h.full_login()
        second = self.h.refresh(info, tokens["refresh_token"])
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(second.json()["refresh_token"], tokens["refresh_token"])
        self.assertEqual(self.h.call_mcp(second.json()["access_token"]).status_code, 200)
        # replaying the already-rotated token = theft signal: the whole session dies
        self.assertEqual(self.h.refresh(info, tokens["refresh_token"]).status_code, 400)
        self.assertEqual(self.h.call_mcp(second.json()["access_token"]).status_code, 401)
        self.assertEqual(self.h.refresh(info, second.json()["refresh_token"]).status_code, 400)

    def test_expired_access_token_rejected(self):
        _, _, _, tokens = self.h.full_login()
        self.h.store.db.execute("UPDATE access SET expires=0")
        self.assertEqual(self.h.call_mcp(tokens["access_token"]).status_code, 401)

    def test_revocation_endpoint_kills_session(self):
        info, _, _, tokens = self.h.full_login()
        r = self.h.client.post("/revoke", data={"token": tokens["access_token"], "client_id": info["client_id"],
                                                "client_secret": info["client_secret"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.h.call_mcp(tokens["access_token"]).status_code, 401)
        self.assertEqual(self.h.refresh(info, tokens["refresh_token"]).status_code, 400)

    def test_revoke_everything_cli_path(self):
        _, _, _, tokens = self.h.full_login()
        self.h.store.revoke_everything()
        self.assertEqual(self.h.call_mcp(tokens["access_token"]).status_code, 401)


class OwnerApprovalTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.info = self.h.register().json()
        self.verifier = secrets.token_urlsafe(48)
        self.location = self.h.authorize(self.info, self.verifier).headers["location"]

    def tearDown(self):
        self.h.client.close()

    def test_authorize_redirects_to_owner_page_not_straight_to_client(self):
        self.assertTrue(self.location.startswith("https://mcp.test/owner/approve?req="))
        page = self.h.client.get(self.location.replace("https://mcp.test", ""))
        self.assertEqual(page.status_code, 200)
        self.assertIn("claude.ai", page.text)
        self.assertEqual(page.headers["x-frame-options"], "DENY")
        self.assertIn("frame-ancestors 'none'", page.headers["content-security-policy"])

    def test_wrong_password_is_refused(self):
        r = self.h.approve(self.location, password="wrong password here")
        self.assertEqual(r.status_code, 401)
        self.assertNotIn("code=", r.headers.get("location", ""))

    def test_wrong_totp_is_refused(self):
        self.assertEqual(self.h.approve(self.location, code="000000").status_code, 401)

    def test_empty_credentials_are_refused(self):
        self.assertEqual(self.h.approve(self.location, password="", code="").status_code, 401)

    def test_totp_cannot_be_replayed(self):
        first = self.h.approve(self.location)
        self.assertEqual(first.status_code, 303)
        second_location = self.h.authorize(self.info, self.verifier).headers["location"]
        replay = self.h.approve(second_location)  # same 30 s step
        self.assertEqual(replay.status_code, 401)
        self.h.next_totp_step()
        self.assertEqual(self.h.approve(second_location).status_code, 303)

    def test_pending_request_is_single_use(self):
        self.assertEqual(self.h.approve(self.location).status_code, 303)
        self.h.next_totp_step()
        self.assertEqual(self.h.approve(self.location).status_code, 400)

    def test_deny_redirects_with_access_denied_and_state(self):
        r = self.h.approve(self.location, password="", code="", action="deny")
        query = parse_qs(urlparse(r.headers["location"]).query)
        self.assertEqual((r.status_code, query["error"], query["state"]), (303, ["access_denied"], ["st8"]))
        self.h.next_totp_step()
        self.assertEqual(self.h.approve(self.location).status_code, 400)

    def test_brute_force_is_throttled_even_with_correct_credentials(self):
        for _ in range(5):
            self.assertEqual(self.h.approve(self.location, password="nope nope nope nope").status_code, 401)
        r = self.h.approve(self.location)
        self.assertEqual(r.status_code, 429)
        self.assertIn("retry-after", r.headers)

    def test_expired_pending_request_is_gone(self):
        self.h.offset += self.h.settings.pending_ttl + 5
        self.assertEqual(self.h.approve(self.location).status_code, 400)

    def test_unknown_pending_id(self):
        self.assertEqual(self.h.client.get("/owner/approve?req=nope").status_code, 400)


class RegistrationAndRoutingTests(unittest.TestCase):
    def test_foreign_redirect_uri_cannot_register(self):
        h = Harness()
        r = h.register("https://evil.example/cb")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "invalid_redirect_uri")

    def test_loopback_redirects_only_when_enabled(self):
        self.assertEqual(Harness().register("http://localhost:3118/callback").status_code, 400)
        self.assertEqual(Harness(allow_loopback_redirects=True).register("http://localhost:3118/callback").status_code, 201)

    def test_client_cap_enforced(self):
        h = Harness(max_clients=2)
        self.assertEqual([h.register().status_code for _ in range(3)], [201, 201, 400])

    def test_resource_for_another_server_is_rejected(self):
        h = Harness()
        info = h.register().json()
        r = h.authorize(info, secrets.token_urlsafe(48), resource="https://other.example/mcp")
        self.assertIn("error=invalid_request", r.headers["location"])
        self.assertNotIn("/owner/approve", r.headers["location"])

    def test_unknown_host_header_rejected(self):
        h = Harness()
        self.assertEqual(h.client.get("/healthz", headers={"host": "evil.example"}).status_code, 400)
        self.assertEqual(h.client.get("/healthz").status_code, 200)

    def test_oversized_body_gets_413_before_reaching_gateway(self):
        h = Harness(max_body=1000)
        _, _, _, tokens = h.full_login()
        r = h.client.post("/mcp", content=b"x" * 2000, headers={"Authorization": "Bearer " + tokens["access_token"],
                                                               "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 413)
        self.assertEqual(h.upstream_requests, [])

    def test_gateway_down_returns_502(self):
        h = Harness()
        _, _, _, tokens = h.full_login()
        h.upstream_error = httpx.ConnectError("refused")
        self.assertEqual(h.call_mcp(tokens["access_token"]).status_code, 502)

    def test_audit_logs_tool_name_but_not_arguments(self):
        h = Harness()
        _, _, _, tokens = h.full_login()
        body = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": "run_shell", "arguments": {"command": "echo TOPSECRET"}}}
        with self.assertLogs("vps-mcp-oauth", "INFO") as logs:
            h.call_mcp(tokens["access_token"], body)
        joined = "\n".join(logs.output)
        self.assertIn("tool=run_shell", joined)
        self.assertNotIn("TOPSECRET", joined)

    def test_unauthenticated_endpoints_are_rate_limited(self):
        h = Harness()
        codes = [h.client.get("/authorize").status_code for _ in range(62)]
        self.assertEqual(codes[-1], 429)
        self.assertNotIn(429, codes[:60])

    def test_state_survives_restart(self):
        with private_tempdir() as d:
            path = os.path.join(d, "o.db")
            with mock.patch.object(op.os, "chmod", wraps=os.chmod) as chmod:
                store = op.Store(path)
                with closing(store.db):
                    store.put_client("c1", "{}")
                restarted = op.Store(path)
                with closing(restarted.db):
                    self.assertEqual(restarted.get_client("c1"), "{}")
                    assert_private_file(self, path, 0o600)
                self.assertEqual(chmod.call_args_list, [mock.call(path, 0o600), mock.call(path, 0o600)])


class UnitTests(unittest.TestCase):
    def test_totp_matches_rfc6238_vector(self):
        key = b"12345678901234567890"  # RFC 6238 appendix B, SHA-1, T=59 -> 94287082 (8 digits)
        self.assertEqual(op.hotp(key, 59 // 30, digits=8), "94287082")

    def test_totp_window_is_one_step(self):
        owner = op.OwnerCredentials.create(PASSWORD)
        now = 1_700_000_000
        step = now // 30
        self.assertEqual(owner.match_totp(op.hotp(owner.totp_key, step + 1), now), step + 1)
        self.assertIsNone(owner.match_totp(op.hotp(owner.totp_key, step + 2), now))
        self.assertIsNone(owner.match_totp("abcdef", now))

    def test_owner_file_round_trip(self):
        owner = op.OwnerCredentials.create(PASSWORD)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "owner.json")
            with open(path, "w") as f:
                f.write(owner.to_json())
            loaded = op.OwnerCredentials.load(path)
        self.assertTrue(loaded.check_password(PASSWORD))
        self.assertFalse(loaded.check_password(PASSWORD + "x"))
        self.assertEqual(loaded.totp_key, owner.totp_key)
        self.assertNotIn(PASSWORD, owner.to_json())

    def test_global_limit_cannot_be_dodged_by_rotating_addresses(self):
        now = [0.0]
        limiter = op.FailureLimiter(per_key=5, global_limit=3, window=100, clock=lambda: now[0])
        for i in range(3):
            limiter.record(f"10.0.0.{i}")
        self.assertGreater(limiter.blocked("10.9.9.9"), 0)
        now[0] = 101
        self.assertEqual(limiter.blocked("10.9.9.9"), 0)

    def test_client_ip_only_trusted_from_loopback_peer(self):
        from starlette.requests import Request

        def make(peer):
            return Request({"type": "http", "headers": [(b"x-real-ip", b"203.0.113.9")], "client": (peer, 1), "method": "GET",
                            "path": "/", "query_string": b""})
        self.assertEqual(op.client_ip(make("127.0.0.1"), "x-real-ip"), "203.0.113.9")
        self.assertEqual(op.client_ip(make("198.51.100.7"), "x-real-ip"), "198.51.100.7")

    def test_settings_validation(self):
        for bad in ("http://mcp.test", "https://mcp.test/path", "mcp.test", "https://u@mcp.test", ""):
            with self.assertRaises(ValueError, msg=bad):
                op.Settings(public_url=bad)
        self.assertEqual(op.Settings(public_url="https://mcp.test/").resource_url, "https://mcp.test/mcp")

    def test_init_owner_cli_writes_private_file_and_rejects_short_password(self):
        with private_tempdir() as d:
            path = os.path.join(d, "oauth", "owner.json")
            with mock.patch("getpass.getpass", side_effect=["short", "short"]), self.assertRaises(SystemExit):
                op.main(["init-owner", "--file", path])
            output = io.StringIO()
            with mock.patch("getpass.getpass", side_effect=[PASSWORD + " 12345", PASSWORD + " 12345"]), \
                    mock.patch.object(op.os, "open", wraps=os.open) as create, redirect_stdout(output):
                op.main(["init-owner", "--file", path])
            create.assert_called_once_with(Path(path + ".tmp"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
            assert_private_file(self, path, 0o640)
            self.assertIn("otpauth://totp/", output.getvalue())
            self.assertTrue(op.OwnerCredentials.load(path).check_password(PASSWORD + " 12345"))
            with mock.patch("getpass.getpass", side_effect=["x" * 20, "x" * 20]), self.assertRaises(SystemExit):
                op.main(["init-owner", "--file", path])  # refuses to overwrite without --force


class DeploymentTests(unittest.TestCase):
    ROOT = os.path.dirname(os.path.abspath(__file__))

    def test_rejected_registration_is_logged_for_diagnosis(self):
        h = Harness()
        with self.assertLogs("vps-mcp-oauth", "WARNING") as logs:
            h.register("https://example.org/their/callback")
        self.assertIn("https://example.org/their/callback", "\n".join(logs.output))
        self.assertIn("OAUTH_EXTRA_REDIRECT_URIS", "\n".join(logs.output))

    def test_settings_from_env(self):
        s = op.Settings.from_env({"OAUTH_PUBLIC_URL": "https://mcp.test", "OAUTH_EXTRA_REDIRECT_URIS": "https://x.example/cb, http://localhost:1/c",
                                  "OAUTH_ALLOW_LOOPBACK": "1", "OAUTH_CLIENT_IP_HEADER": "CF-Connecting-IP"})
        self.assertIn("https://x.example/cb", s.redirect_uris)
        self.assertIn(CLAUDE_CB, s.redirect_uris)
        self.assertTrue(s.allow_loopback_redirects)
        self.assertEqual(s.client_ip_header, "cf-connecting-ip")
        self.assertFalse(op.Settings.from_env({"OAUTH_PUBLIC_URL": "https://mcp.test"}).allow_loopback_redirects)

    def test_service_unit_is_locked_down_and_loopback_only(self):
        with open(os.path.join(self.ROOT, "deploy", "vps-mcp-oauth.service"), encoding="utf-8") as f:
            unit = f.read()
        for directive in ("User=mcp-oauth", "NoNewPrivileges=yes", "ProtectSystem=strict", "IPAddressDeny=any",
                          "IPAddressAllow=localhost", "CapabilityBoundingSet=", "StateDirectoryMode=0700", "PrivateTmp=yes",
                          "SystemCallFilter=@system-service", "EnvironmentFile=/etc/vps-mcp-oauth/oauth.env"):
            self.assertIn(directive + "\n", unit + "\n", directive)
        self.assertNotIn("User=root", unit)
        self.assertNotIn("PRIVATE KEY", unit)

    def test_scripts_do_not_restart_existing_mcp_services(self):
        for name in ("install-oauth.sh", "front-nginx.sh"):
            with open(os.path.join(self.ROOT, "deploy", name), encoding="utf-8") as f:
                text = f.read()
            for protected in ("vps-mcp.service", "vps-mcp-dev", "vps-mcp-approval", "vps-mcp-tunnel"):
                for verb in ("restart", "stop", "disable", "kill"):
                    self.assertNotRegex(text, rf"systemctl\s+{verb}\s+{protected}", f"{name}: {verb} {protected}")


if __name__ == "__main__":
    unittest.main()
