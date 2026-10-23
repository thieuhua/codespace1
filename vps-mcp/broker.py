"""Small root-owned approval broker. Never accepts arbitrary shell or filesystem writes."""
import base64
import hashlib
import hmac
import html
import http.server
import json
import os
import pathlib
import pwd
import re
import secrets
import socket
import socketserver
import struct
import subprocess
import threading
import time
import urllib.parse

RUN = pathlib.Path("/run/vps-mcp-approval")
POLICY = pathlib.Path("/etc/vps-mcp/protected.json")
PASSWORD = pathlib.Path("/etc/vps-mcp/approval-password")
REQUEST_SOCK = RUN / "request.sock"
ADMIN_SOCK = RUN / "admin.sock"
UID = pwd.getpwnam("mcp-gateway").pw_uid
pending = {}
lock = threading.RLock()
MAX_REQ = 16384
TTL_PENDING = 600
TTL_KEY = 180
SERVICE_RE = re.compile(r"^[a-zA-Z0-9@_.-]+\.service$")

def allowed_units():
    obj = json.loads(POLICY.read_text())
    units = obj.get("restart_services", [])
    if not isinstance(units, list) or len(units) > 30:
        raise RuntimeError("Invalid protected policy")
    for unit in units:
        if not isinstance(unit, str) or not SERVICE_RE.fullmatch(unit) or unit.startswith("vps-mcp") or "tunnel" in unit.lower():
            raise RuntimeError("Forbidden protected service policy")
    return units

def purge():
    now = time.time()
    for k, v in list(pending.items()):
        if v["created"] + (1800 if v["status"] in ("consumed", "finished") else TTL_PENDING) < now:
            del pending[k]

def service_fingerprint(unit):
    """Reject aliases of MCP and services executing code from the dev checkout.

    Return stable service-definition fingerprint bound to owner approval.
    """
    if not SERVICE_RE.fullmatch(unit):
        raise ValueError("Invalid systemd unit name")
    properties = ("Id", "Names", "FragmentPath", "DropInPaths", "ExecStart", "ExecStartPre",
                  "ExecStartPost", "WorkingDirectory", "EnvironmentFiles", "PartOf", "Requires", "ConsistsOf")
    argv = ["/usr/bin/systemctl", "show", *["-p" + p for p in properties], "--", unit]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=8)
    if result.returncode:
        raise RuntimeError("Cannot inspect owner-allowlisted service")
    service_data = result.stdout
    if "vps-mcp" in service_data.lower() or "tunnel" in service_data.lower():
        raise PermissionError("Cannot target MCP or tunnel directly or by alias/dependency")
    if "/home/thieuhua/code/codespace1" in service_data:
        raise PermissionError("Refusing restart of a service executing dev-writable project resources")
    return hashlib.sha256(service_data.encode()).hexdigest()

def do_request(op, params):
    if op != "restart_service" or not isinstance(params, dict) or set(params) != {"unit"}:
        raise ValueError("Unsupported operation or arguments")
    unit = params["unit"]
    if unit not in allowed_units():
        raise PermissionError("Service not on owner-managed allowlist")
    fingerprint = service_fingerprint(unit)
    with lock:
        purge()
        if len(pending) >= 100:
            raise RuntimeError("Approval queue full")
        rid = secrets.token_hex(12)
        pending[rid] = {"id": rid, "operation": op, "params": {"unit": unit},
                        "created": time.time(), "status": "pending", "keyhash": None, "expires": 0,
                        "service_fingerprint": fingerprint}
    print("APPROVAL REQUEST", rid, op, unit, flush=True)
    return {"request_id": rid, "operation": op, "params": {"unit": unit}, "status": "pending"}

def execute(rid, key):
    if not isinstance(rid, str) or not isinstance(key, str):
        raise ValueError("Invalid request")
    with lock:
        purge()
        record = pending.get(rid)
        if not record or record["status"] != "approved" or record["expires"] < time.time():
            raise PermissionError("Approval missing or expired")
        if not hmac.compare_digest(hashlib.sha256(key.encode()).digest(), record["keyhash"]):
            raise PermissionError("Wrong approval key")
        # One-time key invalidated BEFORE the privileged operation.
        record["status"] = "consumed"
        record["keyhash"] = None
        operation, params = record["operation"], record["params"].copy()
    if operation != "restart_service" or params["unit"] not in allowed_units():
        raise PermissionError("Policy changed or forbidden")
    if service_fingerprint(params["unit"]) != record["service_fingerprint"]:
        raise PermissionError("Systemd service definition changed since original request")
    result = subprocess.run(["/usr/bin/systemctl", "restart", "--", params["unit"]],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=35)
    details = {"request_id": rid, "exit_code": result.returncode,
               "output": (result.stdout + result.stderr)[-5000:], "status": "finished"}
    with lock:
        record["status"] = "finished"
        record["result"] = details
    print("APPROVAL EXECUTED", rid, operation, params["unit"], result.returncode, flush=True)
    return details

def pending_list():
    with lock:
        purge()
        return [{k: v[k] for k in ("id", "operation", "params", "created", "status", "result") if k in v}
                for v in pending.values()]

def admin_approve(rid):
    with lock:
        purge()
        record = pending.get(rid)
        if not record or record["status"] != "pending":
            raise ValueError("Request missing or already approved")
        if record["operation"] != "restart_service" or record["params"]["unit"] not in allowed_units():
            raise PermissionError("Protected operation no longer allowed")
        if service_fingerprint(record["params"]["unit"]) != record["service_fingerprint"]:
            raise PermissionError("Protected service changed after original request")
        key = secrets.token_urlsafe(32)
        record["status"] = "approved"
        record["keyhash"] = hashlib.sha256(key.encode()).digest()
        record["expires"] = time.time() + TTL_KEY
        print("APPROVAL ISSUED", rid, record["operation"], record["params"], flush=True)
        return {"request_id": rid, "one_time_key": key, "valid_seconds": TTL_KEY,
                "operation": record["operation"], "params": record["params"]}

def action(data, admin=False):
    method = data.get("method")
    if admin:
        if method == "list":
            return pending_list()
        if method == "approve":
            return admin_approve(data["request_id"])
        if method == "deny":
            with lock:
                record = pending.pop(data["request_id"], None)
            return {"denied": bool(record)}
    else:
        if method == "request":
            return do_request(data["operation"], data["params"])
        if method == "execute":
            return execute(data["request_id"], data["key"])
    raise ValueError("Unsupported broker operation")

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        _, uid, _ = struct.unpack("3i", self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        admin = pathlib.Path(self.server.server_address).name == ADMIN_SOCK.name
        if uid != (0 if admin else UID):
            return
        try:
            line = self.rfile.readline(MAX_REQ + 1)
            if len(line) > MAX_REQ:
                raise ValueError("Request too long")
            result = action(json.loads(line), admin=admin)
            data = {"ok": True, "result": result}
        except Exception as e:
            data = {"ok": False, "error": type(e).__name__ + ": " + str(e)}
        self.wfile.write((json.dumps(data, ensure_ascii=False) + "\n").encode())

class SocketServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

def prepare_socket(path, mode, group):
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    server = SocketServer(str(path), Handler)
    os.chown(path, 0, group)
    os.chmod(path, mode)
    return server

class Web(http.server.BaseHTTPRequestHandler):
    server_version = "Approval/1"
    def log_message(self, *_):
        pass

    def authenticated(self):
        provided = self.headers.get("Authorization", "")
        if not provided.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(provided[6:], validate=True).decode()
            user, password = decoded.split(":", 1)
        except (ValueError, UnicodeError):
            return False
        return user == "owner" and hmac.compare_digest(password, PASSWORD.read_text().strip())

    def send_page(self, status, body):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Content-Length", str(len(data)))
        if status == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="VPS Owner Approval"')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/" or not self.authenticated():
            self.send_page(401, "Authentication required")
            return
        rows = []
        for r in pending_list():
            escaped = html.escape(r["id"], quote=True)
            label = html.escape(json.dumps(r["params"], ensure_ascii=False))
            if r["status"] == "pending":
                form = ('<form action="/" method="post"><input type="hidden" name="id" value="' + escaped +
                        '"><input type="hidden" name="csrf" value="' + csrf +
                        '"><button name="decision" value="approve">Approve</button> ' +
                        '<button name="decision" value="deny">Deny</button></form>')
            else:
                form = html.escape(r["status"]) + (" <pre>" + html.escape(json.dumps(r.get("result"), ensure_ascii=False)) + "</pre>" if r.get("result") else "")
            rows.append("<li><strong>" + html.escape(r["operation"]) + "</strong> " + label + " " + form + "</li>")
        self.send_page(200, "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>" +
                       "<title>VPS Approval</title><style>body{font:16px system-ui;max-width:700px;margin:30px auto;padding:20px}" +
                       "li{margin:20px 0;padding:12px;border:1px solid #aaa}button{padding:10px}</style>" +
                       "<h1>VPS Protected Operations</h1><p>Approve only operations you recognize. Keys expire in 180 seconds.</p><ul>" +
                       "".join(rows) + "</ul>")

    def do_POST(self):
        if self.path != "/" or not self.authenticated():
            self.send_page(401, "Authentication required")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= 4096:
                raise ValueError("Invalid request size")
            data = urllib.parse.parse_qs(self.rfile.read(size).decode())
            if not hmac.compare_digest(data.get("csrf", [""])[0], csrf):
                raise PermissionError("Invalid CSRF")
            rid = data["id"][0]
            decision = data["decision"][0]
            if decision == "approve":
                result = admin_approve(rid)
                extra = ("<p>Paste this one-time key into ChatGPT when calling execute_protected:</p><pre>" +
                         html.escape(result["one_time_key"]) + "</pre><p>Request ID: " + html.escape(rid) + "</p>")
            elif decision == "deny":
                with lock:
                    pending.pop(rid, None)
                extra = "<p>Denied.</p>"
            else:
                raise ValueError("Invalid decision")
            self.send_page(200, "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>" +
                           extra + '<p><a href="/">Back to requests</a></p>')
        except Exception as e:
            self.send_page(400, html.escape(type(e).__name__ + ": " + str(e)))

if __name__ == "__main__":
    allowed_units()
    RUN.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chown(RUN, 0, pwd.getpwnam("mcp-gateway").pw_gid)
    os.chmod(RUN, 0o750)
    csrf = secrets.token_urlsafe(24)
    a = prepare_socket(ADMIN_SOCK, 0o600, 0)
    b = prepare_socket(REQUEST_SOCK, 0o660, pwd.getpwnam("mcp-gateway").pw_gid)
    for srv in (a, b):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    # Loopback only. Remote access requires owner-controlled SSH port forwarding.
    http.server.ThreadingHTTPServer(("127.0.0.1", 8767), Web).serve_forever()
