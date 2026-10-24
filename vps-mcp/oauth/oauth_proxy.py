"""OAuth 2.1 front door for the VPS MCP gateway.

Runs as its own service (user ``mcp-oauth``) in front of the unmodified gateway on
127.0.0.1:8765. A remote client (Claude custom connector) discovers this server through
RFC 9728 / RFC 8414 metadata, registers itself (RFC 7591) and sends the owner to
``/owner/approve``. The owner proves identity there with password + TOTP; only then a
short-lived bearer token is issued. ``/mcp`` forwards verified requests to the gateway
and never forwards the credential.

Collaborators (settings, store, owner credentials, limiter, HTTP client, clock) are passed
in through constructors; nothing is read from module-level state except by ``main``.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import struct
import sys
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping
from urllib.parse import quote, urlparse

import httpx
from pydantic import AnyHttpUrl
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from mcp.server.auth.handlers.metadata import ProtectedResourceMetadataHandler
from mcp.server.auth.middleware.bearer_auth import BearerAuthBackend, RequireAuthMiddleware
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    ProviderTokenVerifier,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.server.auth.routes import (
    build_resource_metadata_url,
    cors_middleware,
    create_auth_routes,
    create_protected_resource_routes,
)
from mcp.server.auth.settings import ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken, ProtectedResourceMetadata

log = logging.getLogger("vps-mcp-oauth")

TOKEN_PREFIX_ACCESS = "vmcp_at_"
TOKEN_PREFIX_REFRESH = "vmcp_rt_"
TOKEN_PREFIX_CODE = "vmcp_ac_"
LOOPBACK = ("127.0.0.1", "::1")


def digest(token: str) -> str:
    """Tokens are high-entropy random strings, so a plain SHA-256 is enough at rest."""
    return hashlib.sha256(token.encode()).hexdigest()


# --------------------------------------------------------------------------- settings


@dataclass(frozen=True)
class Settings:
    public_url: str
    upstream: str = "http://127.0.0.1:8765/mcp"
    host: str = "127.0.0.1"
    port: int = 8770
    db_path: str = "/var/lib/vps-mcp-oauth/oauth.db"
    owner_file: str = "/etc/vps-mcp/oauth/owner.json"
    redirect_uris: tuple[str, ...] = (
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
    )
    allow_loopback_redirects: bool = False
    scope: str = "mcp"
    access_ttl: int = 3600
    refresh_ttl: int = 30 * 86400
    code_ttl: int = 300
    pending_ttl: int = 600
    max_clients: int = 20
    max_body: int = 6 * 1024 * 1024
    client_ip_header: str = "x-real-ip"
    upstream_timeout: float = 130.0

    def __post_init__(self) -> None:
        parsed = urlparse(self.public_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment or parsed.username):
            raise ValueError("OAUTH_PUBLIC_URL must look like https://mcp.example.com")
        object.__setattr__(self, "public_url", self.public_url.rstrip("/"))

    @property
    def public_host(self) -> str:
        return urlparse(self.public_url).hostname or ""

    @property
    def resource_url(self) -> str:
        return self.public_url + "/mcp"

    def redirect_allowed(self, uri: str) -> bool:
        if uri in self.redirect_uris:
            return True
        if self.allow_loopback_redirects:
            parsed = urlparse(uri)
            return parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1") and not parsed.fragment
        return False

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        extra = tuple(x for x in re.split(r"[,\s]+", env.get("OAUTH_EXTRA_REDIRECT_URIS", "")) if x)
        defaults = cls.__dataclass_fields__["redirect_uris"].default
        return cls(
            public_url=env.get("OAUTH_PUBLIC_URL", ""),
            upstream=env.get("OAUTH_UPSTREAM", cls.upstream),
            host=env.get("OAUTH_LISTEN_HOST", cls.host),
            port=int(env.get("OAUTH_LISTEN_PORT", cls.port)),
            db_path=env.get("OAUTH_DB", cls.db_path),
            owner_file=env.get("OAUTH_OWNER_FILE", cls.owner_file),
            redirect_uris=defaults + extra,
            allow_loopback_redirects=env.get("OAUTH_ALLOW_LOOPBACK", "0") == "1",
            client_ip_header=env.get("OAUTH_CLIENT_IP_HEADER", cls.client_ip_header).lower(),
        )


def client_ip(request: Request, header: str) -> str:
    peer = request.client.host if request.client else "unknown"
    if peer in LOOPBACK:  # only the local front proxy may vouch for the real address
        forwarded = request.headers.get(header, "").split(",")[-1].strip()
        if forwarded:
            return forwarded
    return peer


# ------------------------------------------------------------------- owner credentials


def hotp(key: bytes, counter: int, digits: int = 6) -> str:
    mac = hmac.new(key, struct.pack(">Q", counter), "sha1").digest()
    offset = mac[-1] & 0x0F
    value = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10 ** digits).zfill(digits)


@dataclass(frozen=True)
class OwnerCredentials:
    salt: bytes
    digest_: bytes
    totp_key: bytes
    n: int = 2 ** 14
    r: int = 8
    p: int = 1

    @staticmethod
    def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
        return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=64 << 20, dklen=32)

    @classmethod
    def create(cls, password: str) -> "OwnerCredentials":
        salt = secrets.token_bytes(16)
        return cls(salt, cls._scrypt(password, salt, 2 ** 14, 8, 1), secrets.token_bytes(20))

    @classmethod
    def load(cls, path: str) -> "OwnerCredentials":
        data = json.loads(Path(path).read_text())
        pw = data["password"]
        return cls(base64.b64decode(pw["salt"]), base64.b64decode(pw["hash"]),
                   base64.b32decode(data["totp_secret"]), pw["n"], pw["r"], pw["p"])

    def to_json(self) -> str:
        return json.dumps({
            "password": {"salt": base64.b64encode(self.salt).decode(), "hash": base64.b64encode(self.digest_).decode(),
                         "n": self.n, "r": self.r, "p": self.p},
            "totp_secret": self.totp_b32,
        }, indent=2) + "\n"

    @property
    def totp_b32(self) -> str:
        return base64.b32encode(self.totp_key).decode()

    def check_password(self, password: str) -> bool:
        return hmac.compare_digest(self._scrypt(password, self.salt, self.n, self.r, self.p), self.digest_)

    def match_totp(self, code: str, now: float) -> int | None:
        """Return the matching 30 s step (window +-1) or None. Always evaluates all candidates."""
        step, found = int(now // 30), None
        for candidate in (step - 1, step, step + 1):
            if hmac.compare_digest(hotp(self.totp_key, candidate), code) and found is None:
                found = candidate
        return found


# ------------------------------------------------------------------------ rate limiting


class FailureLimiter:
    """Sliding-window failure counter: per key (client address) and global across all keys."""

    def __init__(self, per_key: int = 5, global_limit: int = 15, window: float = 900.0,
                 clock: Callable[[], float] = time.monotonic):
        self._per_key, self._global, self._window, self._clock = per_key, global_limit, window, clock
        self._keys: dict[str, deque[float]] = {}
        self._all: deque[float] = deque()
        self._lock = threading.Lock()

    def _trim(self, q: deque[float], now: float) -> None:
        while q and q[0] <= now - self._window:
            q.popleft()

    def blocked(self, key: str) -> int:
        """Seconds until the next attempt is allowed (0 = allowed)."""
        with self._lock:
            now = self._clock()
            self._trim(self._all, now)
            q = self._keys.setdefault(key, deque())
            self._trim(q, now)
            waits = []
            if len(q) >= self._per_key:
                waits.append(q[0] + self._window - now)
            if len(self._all) >= self._global:
                waits.append(self._all[0] + self._window - now)
            return int(max(waits)) + 1 if waits else 0

    def record(self, key: str) -> None:
        with self._lock:
            now = self._clock()
            if len(self._keys) > 10000:
                self._keys.clear()
            self._keys.setdefault(key, deque()).append(now)
            self._all.append(now)


class PathThrottle:
    """Coarse per-address request cap for the unauthenticated OAuth endpoints."""

    def __init__(self, app: ASGIApp, paths: set[str], limit: int, window: float, ip_header: str,
                 clock: Callable[[], float] = time.monotonic):
        self.app, self.paths, self.limit, self.window, self.ip_header, self.clock = app, paths, limit, window, ip_header, clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] in self.paths:
            ip = client_ip(Request(scope), self.ip_header)
            with self._lock:
                now = self.clock()
                if len(self._hits) > 10000:
                    self._hits.clear()
                q = self._hits.setdefault(ip, deque())
                while q and q[0] <= now - self.window:
                    q.popleft()
                over = len(q) >= self.limit
                if not over:
                    q.append(now)
            if over:
                await JSONResponse({"error": "rate_limited"}, status_code=429, headers={"Retry-After": "60"})(scope, receive, send)
                return
        await self.app(scope, receive, send)


# ---------------------------------------------------------------------------- storage

SCHEMA = """
CREATE TABLE IF NOT EXISTS clients(client_id TEXT PRIMARY KEY, info TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS access(hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, family TEXT NOT NULL,
  scopes TEXT NOT NULL, resource TEXT, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS refresh(hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, family TEXT NOT NULL,
  scopes TEXT NOT NULL, resource TEXT, expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class Store:
    """SQLite persistence. Authorization codes and tokens are stored only as SHA-256 digests."""

    def __init__(self, path: str, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.db.execute("INSERT OR IGNORE INTO kv(k, v) VALUES('totp_last', '0')")
        if path != ":memory:":
            os.chmod(path, 0o600)

    def _exec(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self.db.execute(sql, args)

    def purge(self) -> None:
        now = self._clock()
        for table in ("pending", "codes", "access", "refresh"):
            self._exec(f"DELETE FROM {table} WHERE expires < ?", (now,))

    # clients
    def put_client(self, client_id: str, info_json: str) -> None:
        self._exec("INSERT OR REPLACE INTO clients VALUES(?,?,?)", (client_id, info_json, self._clock()))

    def get_client(self, client_id: str) -> str | None:
        row = self._exec("SELECT info FROM clients WHERE client_id=?", (client_id,)).fetchone()
        return row[0] if row else None

    def client_count(self) -> int:
        return self._exec("SELECT COUNT(*) FROM clients").fetchone()[0]

    def prune_idle_clients(self, older_than: float) -> None:
        self._exec("""DELETE FROM clients WHERE created < ? AND client_id NOT IN
                      (SELECT client_id FROM access UNION SELECT client_id FROM refresh)""", (self._clock() - older_than,))

    # authorization requests waiting for the owner
    def create_pending(self, client_id: str, params_json: str, ttl: float) -> str:
        pending_id = secrets.token_urlsafe(24)
        self._exec("INSERT INTO pending VALUES(?,?,?,?)", (pending_id, client_id, params_json, self._clock() + ttl))
        return pending_id

    def get_pending(self, pending_id: str) -> tuple[str, str] | None:
        row = self._exec("SELECT client_id, params FROM pending WHERE id=? AND expires>=?", (pending_id, self._clock())).fetchone()
        return (row[0], row[1]) if row else None

    def take_pending(self, pending_id: str) -> bool:
        return self._exec("DELETE FROM pending WHERE id=? AND expires>=?", (pending_id, self._clock())).rowcount == 1

    # authorization codes (single use)
    def put_code(self, code_hash: str, data_json: str, expires: float) -> None:
        self._exec("INSERT INTO codes VALUES(?,?,?)", (code_hash, data_json, expires))

    def get_code(self, code_hash: str) -> str | None:
        row = self._exec("SELECT data FROM codes WHERE hash=?", (code_hash,)).fetchone()
        return row[0] if row else None

    def take_code(self, code_hash: str) -> bool:
        return self._exec("DELETE FROM codes WHERE hash=?", (code_hash,)).rowcount == 1

    # tokens
    def issue(self, client_id: str, family: str, scopes: list[str], resource: str | None,
              access_hash: str, access_exp: float, refresh_hash: str, refresh_exp: float) -> None:
        with self._lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute("DELETE FROM access WHERE family=?", (family,))
                self.db.execute("INSERT INTO access VALUES(?,?,?,?,?,?)",
                                (access_hash, client_id, family, " ".join(scopes), resource, access_exp))
                self.db.execute("INSERT INTO refresh VALUES(?,?,?,?,?,?,0)",
                                (refresh_hash, client_id, family, " ".join(scopes), resource, refresh_exp))
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def get_access(self, token_hash: str) -> tuple | None:
        return self._exec("SELECT client_id, scopes, resource, expires FROM access WHERE hash=?", (token_hash,)).fetchone()

    def get_refresh(self, token_hash: str) -> tuple | None:
        return self._exec("SELECT client_id, family, scopes, resource, expires, used FROM refresh WHERE hash=?",
                          (token_hash,)).fetchone()

    def mark_refresh_used(self, token_hash: str) -> bool:
        return self._exec("UPDATE refresh SET used=1 WHERE hash=? AND used=0", (token_hash,)).rowcount == 1

    def revoke_family(self, family: str) -> None:
        self._exec("DELETE FROM access WHERE family=?", (family,))
        self._exec("DELETE FROM refresh WHERE family=?", (family,))

    def family_of(self, token_hash: str) -> str | None:
        for table in ("access", "refresh"):
            row = self._exec(f"SELECT family FROM {table} WHERE hash=?", (token_hash,)).fetchone()
            if row:
                return row[0]
        return None

    def revoke_everything(self) -> None:
        for table in ("pending", "codes", "access", "refresh"):
            self._exec(f"DELETE FROM {table}")

    # TOTP replay guard
    def consume_totp_step(self, step: int) -> bool:
        return self._exec("UPDATE kv SET v=? WHERE k='totp_last' AND CAST(v AS INTEGER) < ?", (str(step), step)).rowcount == 1


# --------------------------------------------------------------------------- provider


class OwnerApprovedProvider:
    """OAuthAuthorizationServerProvider whose only approver is the owner (see OwnerApproval)."""

    def __init__(self, settings: Settings, store: Store, clock: Callable[[], float] = time.time):
        self.settings, self.store, self._clock = settings, store, clock

    # --- clients (RFC 7591) ---
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raw = self.store.get_client(client_id)
        return OAuthClientInformationFull.model_validate_json(raw) if raw else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        for uri in client_info.redirect_uris or []:
            if not self.settings.redirect_allowed(str(uri)):
                log.warning("registration rejected: redirect_uri %s is not allowlisted "
                            "(add it to OAUTH_EXTRA_REDIRECT_URIS if it is really your client)", str(uri)[:200])
                raise RegistrationError("invalid_redirect_uri", "redirect_uri is not on this server's allowlist")
        self.store.purge()
        if self.store.client_count() >= self.settings.max_clients:
            self.store.prune_idle_clients(older_than=86400)
        if self.store.client_count() >= self.settings.max_clients:
            raise RegistrationError("invalid_client_metadata", "too many registered clients")
        self.store.put_client(client_info.client_id or "", client_info.model_dump_json())

    # --- authorization ---
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource is not None and params.resource.rstrip("/") != self.settings.resource_url:
            raise AuthorizeError("invalid_request", "resource must be " + self.settings.resource_url)
        self.store.purge()
        pending_id = self.store.create_pending(client.client_id or "", params.model_dump_json(), self.settings.pending_ttl)
        return f"{self.settings.public_url}/owner/approve?req={quote(pending_id)}"

    def complete_authorization(self, params: AuthorizationParams, client_id: str) -> str:
        """Called by OwnerApproval after the owner authenticated. Returns the client redirect URL."""
        code = TOKEN_PREFIX_CODE + secrets.token_urlsafe(32)
        record = AuthorizationCode(
            code=code, scopes=params.scopes or [self.settings.scope], expires_at=self._clock() + self.settings.code_ttl,
            client_id=client_id, code_challenge=params.code_challenge, redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=self.settings.resource_url, subject="owner")
        self.store.put_code(digest(code), record.model_dump_json(), record.expires_at)
        return construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state)

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AuthorizationCode | None:
        raw = self.store.get_code(digest(authorization_code))
        return AuthorizationCode.model_validate_json(raw) if raw else None

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode) -> OAuthToken:
        if not self.store.take_code(digest(authorization_code.code)):  # lost a race / replay
            raise TokenError("invalid_grant", "authorization code already used")
        return self._issue(authorization_code.client_id, authorization_code.scopes, authorization_code.resource, secrets.token_hex(16))

    # --- tokens ---
    def _issue(self, client_id: str, scopes: list[str], resource: str | None, family: str) -> OAuthToken:
        self.store.purge()
        now = self._clock()
        access = TOKEN_PREFIX_ACCESS + secrets.token_urlsafe(32)
        refresh = TOKEN_PREFIX_REFRESH + secrets.token_urlsafe(32)
        self.store.issue(client_id, family, scopes, resource, digest(access), now + self.settings.access_ttl,
                         digest(refresh), now + self.settings.refresh_ttl)
        return OAuthToken(access_token=access, token_type="Bearer", expires_in=self.settings.access_ttl,
                          scope=" ".join(scopes), refresh_token=refresh)

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        row = self.store.get_refresh(digest(refresh_token))
        if not row:
            return None
        client_id, family, scopes, resource, expires, used = row
        if used:  # a rotated token came back: assume theft and kill the whole session
            log.warning("refresh token reuse detected client=%s; revoking session", client_id)
            self.store.revoke_family(family)
            return None
        return RefreshToken(token=refresh_token, client_id=client_id, scopes=scopes.split(), expires_at=int(expires),
                            resource=resource, subject="owner")

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]) -> OAuthToken:
        row = self.store.get_refresh(digest(refresh_token.token))
        if not row or not self.store.mark_refresh_used(digest(refresh_token.token)):
            raise TokenError("invalid_grant", "refresh token already used")
        return self._issue(refresh_token.client_id, scopes or refresh_token.scopes, refresh_token.resource, row[1])

    async def load_access_token(self, token: str) -> AccessToken | None:
        row = self.store.get_access(digest(token))
        if not row or row[3] < self._clock():
            return None
        client_id, scopes, resource, expires = row
        return AccessToken(token=token, client_id=client_id, scopes=scopes.split(), expires_at=int(expires),
                           resource=resource, subject="owner", claims={"iss": self.settings.public_url})

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        family = self.store.family_of(digest(token.token))
        if family:
            self.store.revoke_family(family)


# ------------------------------------------------------------------ owner approval UI

PAGE = """<!doctype html><html lang="vi"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Phê duyệt kết nối MCP</title>
<style>
:root{{color-scheme:light dark}}
body{{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem}}
h1{{font-size:1.25rem}} label{{display:block;margin:.9rem 0 .2rem}}
input{{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem}}
.row{{display:flex;gap:.6rem;margin-top:1.2rem}} button{{flex:1;padding:.7rem;font-size:1rem}}
.warn{{border-left:4px solid #c60;padding:.4rem .8rem;margin:1rem 0}} .err{{color:#c00;font-weight:600}}
</style>
<h1>Phê duyệt kết nối tới VPS MCP</h1>
<p>Ứng dụng <b>{client}</b> (chuyển hướng về <code>{host}</code>) xin quyền dùng các công cụ trên VPS.</p>
<div class="warn">Quyền này gồm đọc/ghi file và chạy lệnh trong sandbox của repo được cấp phép.
Chỉ phê duyệt nếu chính bạn vừa bấm kết nối.</div>
{error}
<form method="post" action="/owner/approve">
<input type="hidden" name="req" value="{req}">
<label for="p">Mật khẩu chủ sở hữu</label>
<input id="p" name="password" type="password" autocomplete="current-password">
<label for="c">Mã TOTP 6 số</label>
<input id="c" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{{6}}" maxlength="6">
<div class="row"><button name="action" value="deny" formnovalidate>Từ chối</button>
<button name="action" value="approve">Phê duyệt</button></div>
</form></html>"""

SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
}


class OwnerApproval:
    def __init__(self, settings: Settings, provider: OwnerApprovedProvider, store: Store,
                 owner: OwnerCredentials, limiter: FailureLimiter, clock: Callable[[], float] = time.time):
        self.settings, self.provider, self.store, self.owner, self.limiter, self._clock = settings, provider, store, owner, limiter, clock

    def _render(self, pending_id: str, client_json: str, params: AuthorizationParams, status: int = 200,
                error: str = "", headers: dict[str, str] | None = None) -> HTMLResponse:
        client = OAuthClientInformationFull.model_validate_json(client_json)
        body = PAGE.format(client=html.escape(client.client_name or client.client_id or "?"),
                           host=html.escape(urlparse(str(params.redirect_uri)).netloc), req=html.escape(pending_id),
                           error=f'<p class="err">{html.escape(error)}</p>' if error else "")
        return HTMLResponse(body, status_code=status, headers={**SECURITY_HEADERS, **(headers or {})})

    def _gone(self) -> HTMLResponse:
        return HTMLResponse("<!doctype html><meta charset=utf-8><p>Yêu cầu không tồn tại hoặc đã hết hạn. "
                            "Hãy bấm kết nối lại từ Claude.</p>", status_code=400, headers=SECURITY_HEADERS)

    def _lookup(self, pending_id: str):
        pending = self.store.get_pending(pending_id)
        if not pending:
            return None
        client_json = self.store.get_client(pending[0])
        if not client_json:
            return None
        return pending[0], client_json, AuthorizationParams.model_validate_json(pending[1])

    async def page(self, request: Request) -> Response:
        pending_id = request.query_params.get("req", "")
        found = self._lookup(pending_id)
        return self._render(pending_id, found[1], found[2]) if found else self._gone()

    async def submit(self, request: Request) -> Response:
        form = await request.form()
        pending_id = str(form.get("req", ""))
        found = self._lookup(pending_id)
        if not found:
            return self._gone()
        client_id, client_json, params = found

        if form.get("action") == "deny":
            self.store.take_pending(pending_id)
            return RedirectResponse(construct_redirect_uri(str(params.redirect_uri), error="access_denied", state=params.state),
                                    status_code=303, headers=SECURITY_HEADERS)

        ip = client_ip(request, self.settings.client_ip_header)
        wait = self.limiter.blocked(ip)
        if wait:
            log.warning("owner login throttled ip=%s", ip)
            return self._render(pending_id, client_json, params, 429, f"Quá nhiều lần thử sai. Thử lại sau {wait} giây.",
                                {"Retry-After": str(wait)})

        password_ok = self.owner.check_password(str(form.get("password", "")))
        step = self.owner.match_totp(str(form.get("code", "")).strip(), self._clock())
        if not (password_ok and step is not None and self.store.consume_totp_step(step)):
            self.limiter.record(ip)
            log.warning("owner login failed ip=%s client=%s", ip, client_id)
            return self._render(pending_id, client_json, params, 401, "Sai mật khẩu hoặc mã TOTP.")
        if not self.store.take_pending(pending_id):
            return self._gone()
        log.warning("owner approved client=%s", client_id)
        return RedirectResponse(self.provider.complete_authorization(params, client_id), status_code=303, headers=SECURITY_HEADERS)


# --------------------------------------------------------------------- MCP forwarding

FORWARD_REQUEST = ("content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id")
FORWARD_RESPONSE = ("content-type", "mcp-session-id", "allow")


class McpProxy:
    """ASGI endpoint: forwards an already-authenticated request to the gateway.

    Only an allowlist of headers goes upstream, so the bearer token, cookies and the
    public Host never reach the gateway.
    """

    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings, self.client = settings, client

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        request = Request(scope, receive)
        await (await self.handle(request))(scope, receive, send)

    async def _body(self, request: Request) -> bytes | None:
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > self.settings.max_body:
            return None
        chunks, total = [], 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > self.settings.max_body:
                return None
            chunks.append(chunk)
        return b"".join(chunks)

    @staticmethod
    def _audit(client_id: str, body: bytes) -> None:
        try:
            payload = json.loads(body)
        except ValueError:
            return
        for item in payload if isinstance(payload, list) else [payload]:
            if isinstance(item, dict) and item.get("method") == "tools/call":
                tool = (item.get("params") or {}).get("name")
                log.info("tools/call tool=%s client=%s bytes=%d", str(tool)[:64], client_id, len(body))

    async def handle(self, request: Request) -> Response:
        body = await self._body(request)
        if body is None:
            return JSONResponse({"error": "request_too_large"}, status_code=413)
        if request.method == "POST" and body:
            self._audit(getattr(request.user, "username", "?"), body)
        headers = {k: v for k, v in request.headers.items() if k.lower() in FORWARD_REQUEST}
        headers["accept-encoding"] = "identity"
        upstream = self.client.build_request(request.method, self.settings.upstream, headers=headers, content=body)
        try:
            response = await self.client.send(upstream, stream=True)
        except httpx.HTTPError as exc:
            log.error("gateway unavailable: %s", type(exc).__name__)
            return JSONResponse({"error": "gateway_unavailable"}, status_code=502)
        out = {k: v for k, v in response.headers.items() if k.lower() in FORWARD_RESPONSE}
        return StreamingResponse(response.aiter_bytes(), status_code=response.status_code, headers=out,
                                 background=BackgroundTask(response.aclose))


# --------------------------------------------------------------------------- app factory


def build_app(settings: Settings, store: Store, owner: OwnerCredentials, limiter: FailureLimiter,
              http_client: httpx.AsyncClient, clock: Callable[[], float] = time.time) -> Starlette:
    provider = OwnerApprovedProvider(settings, store, clock)
    approval = OwnerApproval(settings, provider, store, owner, limiter, clock)
    issuer, resource = AnyHttpUrl(settings.public_url), AnyHttpUrl(settings.resource_url)
    metadata_url = build_resource_metadata_url(resource)

    routes = create_auth_routes(
        provider, issuer,
        client_registration_options=ClientRegistrationOptions(enabled=True, valid_scopes=[settings.scope], default_scopes=[settings.scope]),
        revocation_options=RevocationOptions(enabled=True))
    routes += create_protected_resource_routes(resource, [issuer], scopes_supported=[settings.scope], resource_name="VPS MCP")
    alias = ProtectedResourceMetadataHandler(ProtectedResourceMetadata(
        resource=resource, authorization_servers=[issuer], scopes_supported=[settings.scope], resource_name="VPS MCP"))
    routes.append(Route("/.well-known/oauth-protected-resource", endpoint=cors_middleware(alias.handle, ["GET", "OPTIONS"]),
                        methods=["GET", "OPTIONS"]))
    routes += [
        Route("/owner/approve", approval.page, methods=["GET"]),
        Route("/owner/approve", approval.submit, methods=["POST"]),
        Route("/healthz", lambda request: JSONResponse({"ok": True})),
    ]
    protected = RequireAuthMiddleware(McpProxy(settings, http_client), [settings.scope], metadata_url)
    routes += [Route("/mcp", endpoint=protected), Route("/mcp/", endpoint=protected)]

    @asynccontextmanager
    async def lifespan(app: Starlette):
        yield
        await http_client.aclose()

    app = Starlette(routes=routes, lifespan=lifespan, middleware=[
        Middleware(TrustedHostMiddleware, allowed_hosts=[settings.public_host, "127.0.0.1", "localhost"]),
        Middleware(AuthenticationMiddleware, backend=BearerAuthBackend(ProviderTokenVerifier(provider), resource_server_url=resource)),
    ])
    return PathThrottle(app, {"/register", "/token", "/authorize", "/owner/approve"}, 60, 60.0, settings.client_ip_header)  # type: ignore[return-value]


# ------------------------------------------------------------------------------- CLI


def cmd_serve(_args: argparse.Namespace) -> None:
    import uvicorn

    settings = Settings.from_env(os.environ)
    owner = OwnerCredentials.load(settings.owner_file)
    store = Store(settings.db_path)
    # The gateway is plain HTTP on loopback: never route it through an environment proxy or load CA bundles.
    client = httpx.AsyncClient(timeout=httpx.Timeout(settings.upstream_timeout, connect=5.0), follow_redirects=False,
                               trust_env=False)
    app = build_app(settings, store, owner, FailureLimiter(), client)
    log.warning("serving %s -> %s on %s:%d", settings.public_url, settings.upstream, settings.host, settings.port)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info", access_log=False,
                server_header=False, proxy_headers=False, limit_concurrency=64)


def cmd_init_owner(args: argparse.Namespace) -> None:
    path = Path(args.file)
    if path.exists() and not args.force:
        sys.exit(f"{path} already exists (use --force to replace the owner credentials)")
    password = getpass.getpass("Mật khẩu chủ sở hữu (tối thiểu 14 ký tự): ")
    if len(password) < 14:
        sys.exit("Mật khẩu quá ngắn.")
    if getpass.getpass("Nhập lại: ") != password:
        sys.exit("Hai lần nhập không khớp.")
    creds = OwnerCredentials.create(password)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "w") as f:
        f.write(creds.to_json())
    if args.group:
        shutil.chown(tmp, group=args.group)
    os.replace(tmp, path)
    print("\nThêm khóa TOTP này vào ứng dụng xác thực (Google Authenticator, Authy, ...):")
    print("  Khóa  :", creds.totp_b32)
    print("  Loại  : theo thời gian (TOTP), 6 số, 30 giây, SHA-1")
    print("  URI   : otpauth://totp/VPS%20MCP:owner?secret=" + creds.totp_b32 + "&issuer=VPS%20MCP")


def cmd_revoke_all(args: argparse.Namespace) -> None:
    Store(args.db).revoke_everything()
    print("Đã thu hồi mọi token, mã và yêu cầu đang chờ. Client đã đăng ký được giữ lại.")


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve").set_defaults(func=cmd_serve)
    init = sub.add_parser("init-owner")
    init.add_argument("--file", default="/etc/vps-mcp/oauth/owner.json")
    init.add_argument("--group")
    init.add_argument("--force", action="store_true")
    init.set_defaults(func=cmd_init_owner)
    revoke = sub.add_parser("revoke-all")
    revoke.add_argument("--db", default="/var/lib/vps-mcp-oauth/oauth.db")
    revoke.set_defaults(func=cmd_revoke_all)
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
