"""Drop-in `uno` module backed by the ZetaJS WebAssembly bridge.

Import-compatible with the parts of PyUNO used by the mcp-libre generator
scripts. The real work happens in LibreOffice Wasm; this module is a thin
proxy + value-marshalling layer.
"""

import os
import uuid as _uuid

from uno_ws import importhook as _importhook
from uno_ws.bootstrap import (
    get_component_context,
    get_current_context,
    set_current_context,
    system_path_to_file_url,
    file_url_to_system_path,
)
from uno_ws.types import UnoEnum, UnoStruct, make_struct_class

_importhook.install()

# ── core names (mirroring the native uno module) ─────────────────────────────
Enum = UnoEnum


class Type:
    def __init__(self, type_name):
        if isinstance(type_name, Type):
            type_name = type_name.typeName
        self.typeName = str(type_name)

    def __repr__(self):
        return "Type(%s)" % self.typeName

    def __eq__(self, other):
        return isinstance(other, Type) and other.typeName == self.typeName

    def __hash__(self):
        return hash(self.typeName)


class Any:
    def __init__(self, type_, value=None):
        self.type = type_ if isinstance(type_, Type) else Type(type_)
        self.value = value

    def __repr__(self):
        return "Any(%r, %r)" % (self.type, self.value)


class Bool(int):
    def __new__(cls, value=False):
        return int.__new__(cls, 1 if value else 0)

    def __repr__(self):
        return "True" if self else "False"

    def __str__(self):
        return "true" if self else "false"


class Char(str):
    pass


class ByteSequence(bytes):
    pass


class _ConstantGroup(object):
    pass


def getComponentContext():
    return get_component_context()


def getCurrentContext():
    return get_current_context()


def setCurrentContext(newContext):
    return set_current_context(newContext)


def systemPathToFileUrl(systemPath):
    return system_path_to_file_url(systemPath)


def fileUrlToSystemPath(url):
    return file_url_to_system_path(url)


def createUnoStruct(typeName, *args, **kwargs):
    return make_struct_class(typeName)(*args, **kwargs)


def getClass(typeName):
    return make_struct_class(typeName)


def getTypeByName(typeName):
    return Type(typeName)


def isInterface(obj):
    from uno_ws.proxy import RemoteObject
    return isinstance(obj, RemoteObject)


def generateUuid():
    return str(_uuid.uuid4())


def absolutize(path, relativeUrl):
    if relativeUrl.startswith("file://"):
        return relativeUrl
    return "file://" + os.path.abspath(os.path.join(os.path.dirname(path), relativeUrl))


def invoke(obj, methodname, argTuple):
    return getattr(obj, methodname)(*tuple(argTuple))


def getConstantByName(constant):
    raise NotImplementedError("getConstantByName is not supported by the Wasm bridge")
