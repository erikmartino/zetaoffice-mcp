"""Value marshalling for the UNO-over-WebSocket bridge.

Wire value encoding (JSON):
  primitive            -> true / 42 / 1.5 / "text" / null
  interface (remote)   -> {"$h": <handle>}
  struct               -> {"$s": "<type name>", <field>: <value>, ...}
  enum                 -> {"$e": "<type name>", "v": "<member name>"}
  sequence             -> [ <value>, ... ]
  method reference     -> {"$m": 1}
"""

# Struct field names for the types the generator scripts use. Unknown structs
# accept keyword arguments only (fields are inferred from what is set).
KNOWN_STRUCTS = {
    "com.sun.star.awt.Point": ("X", "Y"),
    "com.sun.star.awt.Size": ("Width", "Height"),
    "com.sun.star.beans.PropertyValue": ("Name", "Handle", "Value", "State"),
}


class _MethodMarker:
    def __repr__(self):
        return "<UNO method>"


METHOD = _MethodMarker()

_STRUCT_CACHE = {}


class UnoEnum:
    """Stand-in for ``uno.Enum``: a named enum member (serialized as an enum)."""

    def __init__(self, type_name, value):
        self.typeName = type_name
        self.value = value

    def __repr__(self):
        return "Enum(%s.%s)" % (self.typeName, self.value)

    def __eq__(self, other):
        return (isinstance(other, UnoEnum)
                and other.typeName == self.typeName
                and other.value == self.value)

    def __hash__(self):
        return hash((self.typeName, self.value))


class UnoStruct:
    """Base class for UNO structs. Field defaults are provided when known."""

    _uno_type = None
    _fields = ()

    def __init__(self, *args, **kwargs):
        if args:
            if not self._fields:
                raise TypeError("%s does not accept positional arguments" % self._uno_type)
            if len(args) > len(self._fields):
                raise TypeError("too many arguments for %s" % self._uno_type)
            for i, val in enumerate(args):
                setattr(self, self._fields[i], val)
        for key, val in kwargs.items():
            setattr(self, key, val)

    def __repr__(self):
        parts = ", ".join("%s=%r" % (k, v) for k, v in self.__dict__.items())
        return "%s(%s)" % (self._uno_type, parts)


def make_struct_class(type_name):
    cls = _STRUCT_CACHE.get(type_name)
    if cls is None:
        fields = KNOWN_STRUCTS.get(type_name, ())
        cls = type(
            "UnoStruct_" + type_name.replace(".", "_"),
            (UnoStruct,),
            {"_uno_type": type_name, "_fields": tuple(fields)},
        )
        _STRUCT_CACHE[type_name] = cls
    return cls


def encode(value):
    """Python value -> JSON-serializable wire value."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        # Mark floats so the worker builds a double Any for property sets.
        return {"$f": value}
    if isinstance(value, str):
        return value
    if isinstance(value, UnoEnum):
        return {"$e": value.typeName, "v": value.value}
    if isinstance(value, UnoStruct):
        out = {"$s": value._uno_type}
        for key, val in value.__dict__.items():
            if not key.startswith("_"):
                out[key] = encode(val)
        return out
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    handle = getattr(value, "_handle", None)
    if handle is not None:
        return {"$h": handle}
    return value


def decode(value, bridge=None):
    """Wire value -> Python value."""
    if value is None:
        return None
    if isinstance(value, list):
        return [decode(v, bridge) for v in value]
    if isinstance(value, dict):
        if "$m" in value:
            return METHOD
        if "$e" in value:
            return UnoEnum(value["$e"], value["v"])
        if "$s" in value:
            obj = make_struct_class(value["$s"])()
            for key, val in value.items():
                if key == "$s":
                    continue
                setattr(obj, key, decode(val, bridge))
            return obj
        if "$h" in value:
            from .proxy import RemoteObject
            return RemoteObject(bridge, value["$h"]) if bridge else value["$h"]
    return value
