"""Repository exclusion and private local state/token paths."""
import os
from pathlib import Path
import stat
import subprocess
import warnings


def restricted_windows_token():
    if os.name != "nt":
        return False
    import win32api
    import win32con
    import win32security
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        return bool(win32security.IsTokenRestricted(token))
    finally:
        token.Close()


def safe_path(value, *, file=False):
    path = Path(value).expanduser().absolute()
    # Check lexical ancestors before resolve() can hide a junction/symlink.
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
            raise ValueError("State/token paths must not contain links or reparse points")
        if (candidate / ".git").exists():
            raise ValueError("State and tokens must be outside repositories")
    path = path.resolve()
    if file and path.exists():
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Token/state files must be regular, unlinked files")
    return path


def state_home(value=None):
    value = value or os.environ.get("AGENT_MAILBOX_HOME")
    if not value:
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise ValueError("Set AGENT_MAILBOX_HOME or --state-dir when LOCALAPPDATA is absent")
        value = Path(local) / "agent-mailbox"
    return safe_path(value)


def owner_only(path):
    """Apply a private DACL where possible; report restricted-token limitations."""
    if os.name != "nt":
        path.chmod(0o700 if path.is_dir() else 0o600)
        return True
    env = os.environ.copy()
    env.pop("PSModulePath", None)  # Do not inherit PowerShell 7 module paths in PS 5.1.
    env["AGENT_MAILBOX_ACL_PATH"] = str(path)
    script = r"""
$ErrorActionPreference = 'Stop'
$p = $env:AGENT_MAILBOX_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ([System.IO.Directory]::Exists($p)) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
}
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
"""
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                            env=env, capture_output=True, timeout=30)
    if result.returncode:
        if restricted_windows_token():
            warnings.warn("Restricted Windows token cannot set owner-only ACLs; inherited ACLs remain. "
                          "Run setup from the owner's normal PowerShell for private ACLs.", RuntimeWarning)
            return False
        raise OSError("Unable to apply owner-only Windows ACL")
    return True


def private_directory(path):
    path = safe_path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner_only(path)
    return path
