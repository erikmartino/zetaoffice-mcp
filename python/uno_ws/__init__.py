"""Minimal UNO-over-WebSocket client used by the `uno` compatibility shim.

This package implements a *dumb* transport: it moves get/set/call/query
operations and values between Python and the ZetaJS worker, where the real
UNO implementation (LibreOffice Wasm) executes them. No UNO semantics are
re-implemented here beyond value marshalling and proxy handling.
"""

from .bridge import Bridge, UnoError
from .types import UnoEnum, UnoStruct, METHOD
from .proxy import RemoteObject

__all__ = [
    "Bridge",
    "UnoError",
    "UnoEnum",
    "UnoStruct",
    "METHOD",
    "RemoteObject",
]
