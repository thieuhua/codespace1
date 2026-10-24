"""Bounded storage + polling benchmark. Prints aggregate JSON, never payloads."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.resource_limits import apply_memory_limit, peak_rss_bytes, LIMIT


def main():
    memory_limit = apply_memory_limit()
    # Import the real MCP/tool stack inside the constrained process too.
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    import json
    import tempfile
    import time
    from mcp.server.fastmcp import FastMCP
    from agent_mailbox.core.admin import Provisioner
    from agent_mailbox.core.database import Database
    from agent_mailbox.core.identity import Principal, trusted_identity
    from agent_mailbox.core.mailboxes import MailboxService
    from agent_mailbox.core.sessions import SessionService
    from agent_mailbox.core.settings import Settings
    from agent_mailbox.core.tools import register
    from tests.support import retry_storage_busy
    started = time.monotonic()
    count = 2000
    with tempfile.TemporaryDirectory() as root:
        settings = Settings(Path(root) / "stress.db", writes_per_minute=10000, max_messages=3000)
        db = Database(settings)
        Provisioner(db).principal("stress", "Stress worker")
        mail = MailboxService(db)
        sessions = SessionService(db)
        mcp = FastMCP("stress", stateless_http=True)
        register(mcp, services=(sessions, mail))
        with trusted_identity(Principal("stress")):
            sid = sessions.open()["session_id"]
            mid = mail.create(sid)["mailbox_id"]
        def write(i):
            with trusted_identity(Principal("stress")):
                result, retry = retry_storage_busy(mail.send, mid, "x" * 1024, idempotency_key=str(i))
                return result["sequence"], retry
        with ThreadPoolExecutor(max_workers=8) as pool:
            writes = list(pool.map(write, range(count)))
        sequences = [seq for seq, _ in writes]
        assert sorted(sequences) == list(range(1, count + 1))
        async def read_and_wait():
            with trusted_identity(Principal("stress")):
                cursor, seen = None, 0
                while True:
                    page = await mail.receive(mid, cursor, limit=100)
                    seen += len(page["messages"])
                    cursor = page["next_cursor"]
                    if not page["has_more"]:
                        break
                assert seen == count
                await asyncio.gather(*(mail.receive(mid, cursor, wait_seconds=0.3) for _ in range(32)))
                assert mail._waiters == 0
        asyncio.run(read_and_wait())
        db.checkpoint()
        db_bytes = settings.db_path.stat().st_size
    peak = peak_rss_bytes()
    assert peak < LIMIT, peak
    print(json.dumps({"messages": count, "writers": 8, "waiters": 32, "payload_bytes": 1024,
                      "busy_retries": sum(retries for _, retries in writes),
                      "seconds": round(time.monotonic() - started, 3), "peak_rss_bytes": peak,
                      "db_bytes": db_bytes, "memory_limit": memory_limit}))


if __name__ == "__main__":
    main()
