"""Lightweight router parser and trusted offline CLI; no HTTP SDK startup."""
import argparse
import json
import time

WATCH_SECONDS = 0.1

def ctl(args, home):
    from .router_store import RouterStore, hold_value
    store = RouterStore(home)
    action = args.router_action
    if action == "send":
        with store.transaction() as conn:
            targets = store.principals(conn) if args.to == "all" else [args.to]
        return {"sent": [store.send("operator", pid, args.text) for pid in targets]}
    if action == "inbox":
        deadline = time.monotonic() + hold_value(args.wait)
        while True:
            page = store.operator_inbox(args.all)
            if page["messages"] or time.monotonic() >= deadline:
                return page
            time.sleep(min(WATCH_SECONDS, max(0, deadline-time.monotonic())))
    if action == "status":
        return store.status()
    if action == "stats":
        return store.stats()
    if action == "log":
        return store.routing_log(args.tail)
    if action in ("stop", "resume"):
        return store.control(args.target, action == "stop")
    if action == "set-hold":
        return store.set_hold(args.seconds)
    if action == "shutdown":
        with store.transaction(write=True) as conn:
            conn.execute("INSERT OR REPLACE INTO settings VALUES ('shutdown','1')")
        return {"shutdown_requested": True}
    raise ValueError("Unknown router command")


def add_parser(commands):
    router = commands.add_parser("router", help="Single HTTP mail router and offline operator CLI")
    router.add_argument("--state-dir", default=argparse.SUPPRESS)
    modes = router.add_subparsers(dest="router_mode", required=True)
    server = modes.add_parser("serve")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8766)
    server.add_argument("--hold-seconds", type=float, default=50)
    server.add_argument("--allow-non-loopback", action="store_true")
    server.add_argument("--state-dir", default=argparse.SUPPRESS)
    control = modes.add_parser("ctl", help="Trusted offline operator (never an MCP tool)")
    actions = control.add_subparsers(dest="router_action", required=True)
    send = actions.add_parser("send")
    send.add_argument("--to", required=True)
    send.add_argument("text")
    inbox = actions.add_parser("inbox")
    inbox.add_argument("--wait", type=float, default=0)
    inbox.add_argument("--all", action="store_true")
    actions.add_parser("status")
    actions.add_parser("stats")
    log = actions.add_parser("log")
    log.add_argument("--tail", type=int, default=50)
    for name in ("stop", "resume"):
        actions.add_parser(name).add_argument("target")
    actions.add_parser("set-hold").add_argument("seconds", type=float)
    actions.add_parser("shutdown", help="Graceful server shutdown (used by router-stop.ps1)")
    for sub in [control, *actions.choices.values()]:
        sub.add_argument("--state-dir", default=argparse.SUPPRESS)
        sub.add_argument("--json", action="store_true", default=argparse.SUPPRESS)


def run(args, home):
    if args.router_mode == "serve":
        from .router import serve
        serve(args, home)
    else:
        value = ctl(args, home)
        if getattr(args, "json", False):
            print(json.dumps(value, ensure_ascii=True))
        else:
            print(json.dumps(value, ensure_ascii=False, indent=2))
