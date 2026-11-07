"""Local stand-ins for the PyUNO bootstrap chain.

The native scripts resolve a remote component context via a URP socket. Here
the same call chain is served locally: `UnoUrlResolver.resolve()` simply
returns the remote (Wasm) component context over WebSocket, ignoring the
socket/pipe part of the connection string.
"""

import os

from .bridge import Bridge, ensure_bridge

_bridge = None
_context = None
_current_context = None


def get_bridge():
    global _bridge
    if _bridge is None:
        ensure_bridge()
        _bridge = Bridge()
    return _bridge


class _LocalServiceManager:
    def __init__(self, context):
        self._context = context

    def createInstanceWithContext(self, name, context=None):
        if name == "com.sun.star.bridge.UnoUrlResolver":
            return _UnoUrlResolver(self._context)
        # Anything else is forwarded to the remote service manager.
        remote_ctx = self._context.remote_context()
        return remote_ctx.ServiceManager.createInstanceWithContext(name, remote_ctx)


class LocalContext:
    """The object returned by `uno.getComponentContext()`."""

    def __init__(self, bridge):
        self._bridge = bridge
        self._sm = _LocalServiceManager(self)

    @property
    def ServiceManager(self):
        return self._sm

    def remote_context(self):
        return self._bridge.root()


class _UnoUrlResolver:
    def __init__(self, context):
        self._context = context

    def resolve(self, url):
        # The URL is intentionally ignored; everything is the Wasm context.
        return self._context.remote_context()

    def resolveWithContext(self, url, context, cache):
        return self._context.remote_context()


def get_component_context():
    global _context
    if _context is None:
        _context = LocalContext(get_bridge())
    return _context


def get_current_context():
    return _current_context if _current_context is not None else get_component_context()


def set_current_context(ctx):
    global _current_context
    old = _current_context
    _current_context = ctx
    return old


def system_path_to_file_url(system_path):
    return get_bridge().register_output(system_path)


def file_url_to_system_path(url):
    if url.startswith("file://"):
        path = url[7:]
        bridge = get_bridge()
        host = bridge._wasm_to_host.get(path)
        if host:
            return host
        return path
    return url
