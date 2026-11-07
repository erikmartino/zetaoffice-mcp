"""Dynamic proxy for a remote UNO object addressed by an integer handle."""

from .types import METHOD, encode, decode


class _BoundMethod:
    def __init__(self, proxy, name):
        self._proxy = proxy
        self._name = name

    def __call__(self, *args):
        return self._proxy._invoke(self._name, args)

    def __repr__(self):
        return "<UNO method %s of %r>" % (self._name, self._proxy)


class RemoteObject:
    """A remote UNO interface reference.

    Attribute access performs a get-probe: if the member is a method it is
    returned as a bound callable, otherwise the decoded property value is
    returned. Attribute assignment maps to a UNO property set.
    """

    def __init__(self, bridge, handle):
        object.__setattr__(self, "_bridge", bridge)
        object.__setattr__(self, "_handle", handle)
        object.__setattr__(self, "_member_cache", {})

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        cache = object.__getattribute__(self, "_member_cache")
        cached = cache.get(name)
        if cached is not None:
            return cached
        bridge = object.__getattribute__(self, "_bridge")
        handle = object.__getattribute__(self, "_handle")
        probe = bridge.op_get(handle, name)
        if probe is METHOD:
            member = _BoundMethod(self, name)
            cache[name] = member
            return member
        return probe

    def __setattr__(self, name, value):
        if name.startswith("_"):
            object.__setattr__(self, name, value)
            return
        bridge = object.__getattribute__(self, "_bridge")
        handle = object.__getattribute__(self, "_handle")
        bridge.op_set(handle, name, value)

    def __call__(self, *args):
        # Allows using an interface reference directly as a callable.
        raise TypeError("UNO interface references are not callable: %r" % self)

    def _invoke(self, name, args):
        bridge = object.__getattribute__(self, "_bridge")
        handle = object.__getattribute__(self, "_handle")
        return bridge.op_call(handle, name, args)

    def queryInterface(self, iface):
        bridge = object.__getattribute__(self, "_bridge")
        handle = object.__getattribute__(self, "_handle")
        name = iface if isinstance(iface, str) else getattr(iface, "_uno_type", str(iface))
        return bridge.op_query(handle, name)

    def __repr__(self):
        return "<UNO object h=%s>" % object.__getattribute__(self, "_handle")
