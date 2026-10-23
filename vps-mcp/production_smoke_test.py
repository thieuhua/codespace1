"""Compare source with live release; no production mutations."""
import ast
import hashlib
from pathlib import Path
HERE = Path(__file__).resolve().parent
LIVE = Path("/opt/vps-mcp/current")

def test_production_sources_compile_and_match():
    for name in ("gateway.py", "worker.py", "broker.py"):
        source = (HERE / name).read_bytes()
        ast.parse(source, filename=name)
        if (LIVE / name).is_file():
            assert hashlib.sha256(source).digest() == hashlib.sha256((LIVE / name).read_bytes()).digest()
    assert (HERE / "gateway.py").read_text().count("@mcp.tool()") == 16

def test_worker_separation():
    assert "SO_PEERCRED" in (HERE / "worker.py").read_text()
    assert "mcp-dev" in (HERE / "worker.py").read_text()

def test_unit_definitions():
    root = HERE / "deploy/production"
    for unit in ("vps-mcp.service", "vps-mcp-dev.service", "vps-mcp-approval.service"):
        data = (root / unit).read_text()
        assert "[Service]" in data
        assert "NoNewPrivileges=yes" in data
        assert "PRIVATE KEY" not in data
