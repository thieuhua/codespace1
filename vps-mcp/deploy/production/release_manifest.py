"""List runtime source files for owner-side staging; performs no installation."""
from pathlib import Path
import sys


def source_files(root):
    root = Path(root)
    names = ["gateway.py", "worker.py", "broker.py"]
    package = root / "mailbox_core"
    names += sorted(str(p.relative_to(root).as_posix()) for p in package.rglob("*")
                    if p.suffix in (".py", ".sql"))
    if "mailbox_core/__init__.py" not in names or "mailbox_core/migrations/001_initial.sql" not in names:
        raise ValueError("Incomplete mailbox runtime package")
    for name in names:
        path = root / name
        if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError("Runtime sources must be regular unlinked paths")
    return names


if __name__ == "__main__":
    print("\n".join(source_files(sys.argv[1])))
