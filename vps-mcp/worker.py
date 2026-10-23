"""Development worker: runs as mcp-dev, never as the MCP gateway identity."""
import json
import os
import pathlib
import pwd
import resource
import signal
import socket
import socketserver
import struct
import subprocess
import tempfile
import threading
import time
import uuid

BASE = pathlib.Path("/home/thieuhua/code")
SOCKET = os.environ.get("MCP_WORKER_SOCKET", "/run/vps-mcp/worker.sock")
REPOS = {name: pathlib.Path(path).resolve() for name, path in json.loads(
    os.environ.get("MCP_REPOS", '{"codespace1":"/home/thieuhua/code/codespace1"}')).items()}
if not REPOS or any("/" in name or name in (".", "..") for name in REPOS):
    raise RuntimeError("Invalid project allowlist")
for p in REPOS.values():
    if not p.is_dir() or not (p / ".git").exists():
        raise RuntimeError("Missing allowed git repository: " + str(p))
MAX_READ = 1024 * 1024
MAX_WRITE = 1024 * 1024
MAX_OUTPUT = 65536
MAX_COMMAND = 16384
MAX_JOBS = 8
jobs = {}
lock = threading.RLock()
JOB_DIR = pathlib.Path(os.environ.get("MCP_JOB_DIR", "/var/lib/vps-mcp-dev/jobs"))
JOB_DIR.mkdir(parents=True, exist_ok=True)

def resolve(path=".", *, directory=False):
    if not isinstance(path, str) or "\x00" in path:
        raise ValueError("Invalid path")
    if path in ("", "."):
        if directory:
            return next(iter(REPOS.values()))
        return None
    given = pathlib.Path(path)
    candidate = (given if given.is_absolute() else BASE / given).resolve()
    if not any(candidate == p or candidate.is_relative_to(p) for p in REPOS.values()):
        raise PermissionError("Path outside allowed repositories")
    if directory and not candidate.is_dir():
        raise ValueError("Working directory does not exist")
    return candidate

def environment():
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/var/lib/vps-mcp-dev",
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "GIT_AUTHOR_NAME": "VPS MCP Agent",
        "GIT_AUTHOR_EMAIL": "mcp-agent@localhost",
        "GIT_COMMITTER_NAME": "VPS MCP Agent",
        "GIT_COMMITTER_EMAIL": "mcp-agent@localhost",
        "GIT_CONFIG_COUNT": str(len(REPOS)),
    }
    for i, p in enumerate(REPOS.values()):
        env["GIT_CONFIG_KEY_" + str(i)] = "safe.directory"
        env["GIT_CONFIG_VALUE_" + str(i)] = str(p)
    return env

def child_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024, 512 * 1024 * 1024))

def spawn(command, path, logfile):
    if not isinstance(command, str) or not command.strip() or len(command.encode()) > MAX_COMMAND or "\x00" in command:
        raise ValueError("Invalid shell command")
    cwd = resolve(path, directory=True)
    return subprocess.Popen(
        ["/bin/bash", "--noprofile", "--norc", "-c", command],
        cwd=str(cwd), env=environment(),
        stdin=subprocess.DEVNULL, stdout=logfile, stderr=subprocess.STDOUT,
        start_new_session=True, preexec_fn=child_limits,
    )

def kill_job(proc):
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass

def output_summary(proc, filename, start, *, timeout=False):
    with open(filename, "rb") as f:
        f.seek(0, os.SEEK_END)
        n = f.tell()
        f.seek(max(0, n - MAX_OUTPUT))
        out = f.read()
    return ("exit=" + str(proc.poll()) + " timed_out=" + str(timeout).lower() +
            " output_limited=" + str(n >= 512 * 1024 * 1024).lower() +
            " truncated=" + str(n > len(out)).lower() +
            " duration_s=" + str(round(time.time() - start, 2)) + "\n" +
            out.decode("utf-8", errors="replace"))

def dispatch(method, args):
    if method == "projects":
        return {k: str(v) for k, v in REPOS.items()}
    if method == "list_files":
        p = resolve(args.get("path", "."))
        if p is None:
            return [k + "/" for k in REPOS]
        if not p.is_dir():
            raise ValueError("Not a directory")
        return sorted(x.name + ("/" if x.is_dir() else "") for x in p.iterdir())[:1000]
    if method == "read_file":
        p = resolve(args["path"])
        if not p.is_file() or p.stat().st_size > MAX_READ:
            raise ValueError("Missing file or file exceeds 1 MiB")
        return p.read_text(encoding="utf-8")
    if method == "write_file":
        data = args["content"]
        if not isinstance(data, str) or len(data.encode("utf-8")) > MAX_WRITE:
            raise ValueError("Invalid or oversized content")
        p = resolve(args["path"])
        if not p.parent.is_dir() or p.is_dir():
            raise ValueError("Parent must exist; target must be a file")
        p.write_text(data, encoding="utf-8")
        return str(p)
    if method == "mkdir":
        p = resolve(args["path"])
        p.mkdir(parents=bool(args.get("parents", False)), exist_ok=False)
        return str(p)
    if method == "rename":
        source = resolve(args["source"])
        target = resolve(args["target"])
        if target.exists():
            raise FileExistsError("Destination already exists")
        source.rename(target)
        return str(target)
    if method == "remove":
        p = resolve(args["path"])
        if p in REPOS.values():
            raise PermissionError("Cannot remove a repository root")
        if p.is_dir():
            p.rmdir()
        else:
            p.unlink()
        return str(p)
    if method == "git_status":
        cwd = resolve(args.get("path", "."), directory=True)
        return run_sync("git status --short --branch", str(cwd), 15)
    if method == "run_shell":
        return run_sync(args["command"], args.get("path", "."), args.get("timeout_seconds", 30))
    if method == "start_job":
        command = args["command"]
        cwd = args.get("path", ".")
        with lock:
            if sum(p["proc"].poll() is None for p in jobs.values()) >= MAX_JOBS:
                raise RuntimeError("Too many active jobs")
            jobid = uuid.uuid4().hex
            filename = JOB_DIR / (jobid + ".log")
            start = time.time()
            with filename.open("wb") as logfile:
                proc = spawn(command, cwd, logfile)
            jobs[jobid] = {"proc": proc, "file": filename, "start": start}
        return {"job_id": jobid, "pid": proc.pid, "status": "running"}
    if method == "read_job_log":
        j = jobs.get(args["job_id"])
        if not j:
            raise KeyError("Unknown job ID")
        offset = args.get("offset", 0)
        maximum = args.get("max_bytes", 32768)
        if type(offset) is not int or offset < 0 or type(maximum) is not int or not 1 <= maximum <= 65536:
            raise ValueError("Invalid log range")
        with j["file"].open("rb") as infile:
            infile.seek(0, 2)
            size = infile.tell()
            infile.seek(min(offset, size))
            chunk = infile.read(maximum)
        return {"job_id": args["job_id"], "offset": offset, "next_offset": min(offset, size) + len(chunk),
                "total_bytes": size, "data": chunk.decode("utf-8", errors="replace")}
    if method in ("job_status", "stop_job"):
        j = jobs.get(args["job_id"])
        if not j:
            raise KeyError("Unknown job ID")
        proc = j["proc"]
        if method == "stop_job":
            kill_job(proc)
        return {"job_id": args["job_id"], "status": "running" if proc.poll() is None else "finished",
                "result": output_summary(proc, j["file"], j["start"])}
    raise ValueError("Unsupported method")

def run_sync(command, path, timeout):
    if type(timeout) is not int or not 1 <= timeout <= 90:
        raise ValueError("Timeout must be 1..90 seconds")
    with tempfile.TemporaryFile() as outfile:
        start = time.time()
        proc = spawn(command, path, outfile)
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_job(proc)
        outfile.seek(0, os.SEEK_END)
        n = outfile.tell()
        outfile.seek(max(0, n - MAX_OUTPUT))
        data = outfile.read()
        return ("exit=" + str(proc.returncode) + " timed_out=" + str(timed_out).lower() +
                " output_limited=" + str(n >= 512 * 1024 * 1024).lower() +
                " truncated=" + str(n > len(data)).lower() +
                " duration_s=" + str(round(time.time() - start, 2)) + "\n" +
                data.decode("utf-8", errors="replace"))

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        credentials = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        _, uid, _ = struct.unpack("3i", credentials)
        expected = int(os.environ.get("MCP_GATEWAY_UID", str(os.getuid())))
        if uid != expected:
            return
        line = self.rfile.readline(4 * 1024 * 1024 + 1)
        try:
            if len(line) > 4 * 1024 * 1024:
                raise ValueError("Request too large")
            request = json.loads(line)
            result = dispatch(request["method"], request.get("args", {}))
            payload = {"ok": True, "result": result}
        except Exception as exc:
            payload = {"ok": False, "error": type(exc).__name__ + ": " + str(exc)}
        self.wfile.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

if __name__ == "__main__":
    socket_path = pathlib.Path(SOCKET)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    server = Server(SOCKET, Handler)
    os.chmod(SOCKET, 0o660)
    server.serve_forever(poll_interval=0.25)
