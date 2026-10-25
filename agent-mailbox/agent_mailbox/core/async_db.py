"""Bounded shared SQLite workers; preserve trusted request ContextVars."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from functools import partial
import threading
from .errors import exhausted

_workers = ThreadPoolExecutor(max_workers=4, thread_name_prefix="gateway-db")
_capacity = threading.BoundedSemaphore(64)


async def run_db(fn, *args, **kwargs):
    if not _capacity.acquire(blocking=False):
        exhausted("Storage request capacity reached; retry later")
    try:
        future = _workers.submit(copy_context().run, partial(fn, *args, **kwargs))
    except BaseException:
        _capacity.release()
        raise
    # Release even if cancelled while queued; running transactions finish within
    # the busy timeout. No unbounded executor queue or per-principal thread pool.
    future.add_done_callback(lambda _: _capacity.release())
    return await asyncio.wrap_future(future)
