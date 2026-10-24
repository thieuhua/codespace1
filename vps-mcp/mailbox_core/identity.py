"""Trusted authentication bridge; never populated from tool arguments/headers.

A future verified transport adapter must bind this context for each request.
There is deliberately no environment-variable, owner-ID or header fallback.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from .errors import GatewayError


@dataclass(frozen=True)
class Principal:
    principal_id: str


_principal: ContextVar[Principal | None] = ContextVar("verified_principal", default=None)


def current_principal() -> Principal:
    principal = _principal.get()
    if not isinstance(principal, Principal):
        raise GatewayError("UNAUTHENTICATED", "Trusted authentication required")
    return principal


@contextmanager
def trusted_identity(principal: Principal):
    """SERVER/TEST ADAPTER ONLY. Caller must have independently verified identity.

    This Python API confers authority; never register it as an MCP tool.
    """
    if not isinstance(principal, Principal) or not principal.principal_id:
        raise ValueError("verified principal required")
    token = _principal.set(principal)
    try:
        yield
    finally:
        _principal.reset(token)
