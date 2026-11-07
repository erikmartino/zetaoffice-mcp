"""Import hook so `from com.sun.star.awt import Point, Size` works.

Any name under `com.sun.star.*` resolves lazily to a UNO struct class. This is
enough for the generator scripts (Point/Size/PropertyValue); enums are passed
through ``uno.Enum`` rather than imported.
"""

import importlib.abc
import importlib.machinery
import sys
import types


class _UnoModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        from .types import make_struct_class
        return make_struct_class(self.__name__ + "." + name)


class _UnoNamespaceFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if (fullname == "com"
                or fullname == "com.sun"
                or fullname == "com.sun.star"
                or fullname.startswith("com.sun.star.")):
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        module = _UnoModule(spec.name)
        module.__path__ = []
        return module

    def exec_module(self, module):
        pass


_INSTALLED = False


def install():
    global _INSTALLED
    if _INSTALLED:
        return
    for finder in sys.meta_path:
        if isinstance(finder, _UnoNamespaceFinder):
            _INSTALLED = True
            return
    sys.meta_path.insert(0, _UnoNamespaceFinder())
    _INSTALLED = True
