"""Public errors contain stable codes and no SQL, paths or payloads."""
class GatewayError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def invalid(message="Invalid argument"):
    raise GatewayError("INVALID_ARGUMENT", message)


def missing():
    # Same response for absent IDs and IDs without ACL membership.
    raise GatewayError("NOT_FOUND", "Resource not available")


def exhausted(message="Resource limit reached"):
    raise GatewayError("RESOURCE_EXHAUSTED", message)
