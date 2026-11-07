"""Import-compatible `unohelper` shim (only the pieces needed to import)."""


def systemPathToFileUrl(systemPath):
    import uno
    return uno.systemPathToFileUrl(systemPath)


def fileUrlToSystemPath(url):
    import uno
    return uno.fileUrlToSystemPath(url)


class Base:
    """Minimal stand-in for unohelper.Base."""

    def getTypes(self):
        return []

    def getImplementationId(self):
        return b""


class Implemented:
    def __init__(self, *interfaces):
        self._interfaces = interfaces


class ImplementationHelper:
    def __init__(self):
        self._implementations = {}

    def addImplementation(self, implementationName, class_, supportedServices, supportedInterfaces=()):
        self._implementations[implementationName] = (class_, supportedServices, supportedInterfaces)

    def writeRegistryInfo(self, registry, key):
        return True

    def getComponentFactory(self, implementationName):
        raise NotImplementedError("component factories are not supported by the Wasm bridge")
