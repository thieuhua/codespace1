"""Test-process guard: never bind/contact the live endpoint or privileged IPC."""
import socket

_connect = socket.socket.connect
_bind = socket.socket.bind


def _check(address):
    if isinstance(address, tuple) and len(address) >= 2 and address[1] == 8765:
        raise AssertionError("Tests cannot bind/contact production port 8765")
    if isinstance(address, (str, bytes)):
        path = address.decode() if isinstance(address, bytes) else address
        if path.startswith("/run/vps-mcp"):
            raise AssertionError("Tests cannot bind/contact privileged production IPC")


def _isolated_connect(sock, address):
    _check(address)
    return _connect(sock, address)


def _isolated_bind(sock, address):
    _check(address)
    return _bind(sock, address)


socket.socket.connect = _isolated_connect
socket.socket.bind = _isolated_bind
