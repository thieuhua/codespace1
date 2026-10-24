"""Child process fixtures: durable commit and deliberate uncommitted crash."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_mailbox.core.admin import Provisioner
from agent_mailbox.core.database import Database
from agent_mailbox.core.identity import Principal, trusted_identity
from agent_mailbox.core.mailboxes import MailboxService
from agent_mailbox.core.sessions import SessionService
from agent_mailbox.core.settings import Settings


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
