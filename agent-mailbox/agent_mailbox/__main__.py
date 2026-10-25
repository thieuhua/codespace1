"""python -m agent_mailbox serve | admin ..."""
import argparse
import json
import sys

from .paths import state_home


def parser():
    root = argparse.ArgumentParser(description="Local stdio Session + Mailbox MCP")
    root.add_argument("--state-dir", help="State outside repositories (default LOCALAPPDATA/agent-mailbox)")
    commands = root.add_subparsers(dest="command", required=True)
    from .router_cli import add_parser
    add_parser(commands)
    serve = commands.add_parser("serve", help="stdio MCP; no state initialization")
    serve.add_argument("--token-file")
    serve.add_argument("--state-dir", default=argparse.SUPPRESS)
    admin = commands.add_parser("admin", help="Trusted offline administration; not MCP tools")
    admin.add_argument("--state-dir", default=argparse.SUPPRESS)
    actions = admin.add_subparsers(dest="action", required=True)
    actions.add_parser("init")
    add = actions.add_parser("add-principal")
    add.add_argument("id")
    add.add_argument("--label")
    add.add_argument("--token-file")
    add.add_argument("--print-token", action="store_true")
    modes = add.add_mutually_exclusive_group()
    modes.add_argument("--if-missing", action="store_true")
    modes.add_argument("--rotate", action="store_true")
    for name in ("revoke", "disable"):
        actions.add_parser(name).add_argument("id")
    actions.add_parser("list-principals")
    actions.add_parser("cleanup")
    shared = actions.add_parser("create-shared-session")
    shared.add_argument("--owner", required=True)
    shared.add_argument("--participant", action="append", default=[])
    shared.add_argument("--name", default="collab")
    shared.add_argument("--mailbox", default="collab")
    shared.add_argument("--ttl-seconds", type=int, default=604800)
    for sub in actions.choices.values():
        sub.add_argument("--state-dir", default=argparse.SUPPRESS)
    return root


def main():
    args = parser().parse_args()
    try:
        home = state_home(args.state_dir)
        if args.command == "serve":
            from .auth import load_token
            from .server import serve
            serve(home, load_token(args.token_file))
        elif args.command == "router":
            from .router_cli import run
            run(args, home)
        else:
            from .admin import run
            print(json.dumps(run(args, home), ensure_ascii=True))
        return 0
    except Exception as exc:
        # Never print SQL, token contents, payloads or exception strings.
        if args.command == "router" and getattr(args, "json", False):
            from .core.errors import GatewayError
            code = exc.code if isinstance(exc, GatewayError) else "OPERATION_FAILED"
            print(json.dumps({"error": {"code": code, "message": "Router operation failed"}}))
        print("agent-mailbox: operation failed; check arguments, provisioning, paths and permissions", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
