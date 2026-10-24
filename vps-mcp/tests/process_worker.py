"""Child process fixtures: durable commit and deliberate uncommitted crash."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mailbox_core.admin import Provisioner
from mailbox_core.database import Database
from mailbox_core.identity import Principal, trusted_identity
from mailbox_core.mailboxes import MailboxService
from mailbox_core.sessions import SessionService
from mailbox_core.settings import Settings


def main():
    mode, path = sys.argv[1:]
    db = Database(Settings(Path(path)))
    admin = Provisioner(db)
    with trusted_identity(Principal("A")):
        if mode == "commit":
            admin.principal("A", "Agent A")
            session = SessionService(db).open(idempotency_key="session")
            box = MailboxService(db).create(session["session_id"])
            message = MailboxService(db).send(box["mailbox_id"], "durable", idempotency_key="task")
            print(json.dumps({"session": session, "mailbox": box, "message": message}), flush=True)
            # Simulates abrupt process loss immediately after an acknowledged commit.
            os._exit(0)
        elif mode == "crash":
            with db.transaction(write=True) as conn:
                conn.execute("UPDATE mailboxes SET last_sequence=999")
                conn.execute("UPDATE messages SET text='uncommitted'")
                os._exit(7)
        else:
            raise ValueError("unknown fixture mode")


if __name__ == "__main__":
    main()
