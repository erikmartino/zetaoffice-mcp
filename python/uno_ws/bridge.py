"""Connection to the Node UNO-over-WebSocket broker and the op dispatcher."""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

from .types import encode, decode
from .wsclient import WSClient

DEFAULT_PORT = int(os.environ.get("LIBREOFFICE_PORT", os.environ.get("PORT", "8765")))
DEFAULT_WS_URL = os.environ.get("UNO_WS_URL", "ws://127.0.0.1:%d/uno" % DEFAULT_PORT)
DEFAULT_HTTP_URL = os.environ.get("LIBREOFFICE_URL", "http://127.0.0.1:%d" % DEFAULT_PORT)


class UnoError(RuntimeError):
    pass


def _demo_dir():
    # python/uno_ws/bridge.py -> repo root
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _health(url):
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/health", timeout=1) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def ensure_bridge(timeout=90):
    """Start `node server.mjs --headless` if the bridge is not already up."""
    health = _health(DEFAULT_HTTP_URL)
    if health and health.get("status") == "healthy":
        return True
    demo = _demo_dir()
    server_js = os.path.join(demo, "server.mjs")
    if not os.path.isfile(server_js):
        raise UnoError("bridge server not found at %s" % server_js)
    env = dict(os.environ)
    env["HEADLESS"] = "true"
    env["LIBREOFFICE_PORT"] = str(DEFAULT_PORT)
    print("[uno_ws] starting headless Wasm bridge (node server.mjs --headless)...", file=sys.stderr)
    subprocess.Popen(
        ["node", server_js, "--headless"],
        cwd=demo, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        health = _health(DEFAULT_HTTP_URL)
        if health and health.get("browser_connected"):
            return True
        time.sleep(1.0)
    raise UnoError("timed out waiting for the Wasm bridge to become ready")


class Bridge:
    def __init__(self, url=None):
        self.url = url or DEFAULT_WS_URL
        self.ws = WSClient(self.url)
        self._seq = 0
        self._root = None
        self._out_seq = 0
        self._wasm_to_host = {}

    # ── low-level RPC ────────────────────────────────────────────────────
    def _req(self, payload):
        self._seq += 1
        payload["id"] = self._seq
        self.ws.send_text(json.dumps(payload))
        while True:
            resp = json.loads(self.ws.recv_text())
            if resp.get("id") != self._seq:
                continue
            if not resp.get("ok"):
                err = resp.get("e") or {}
                raise UnoError(err.get("msg", "UNO operation failed"))
            return decode(resp.get("v"), self)

    def root(self, timeout=120):
        if self._root is not None:
            return self._root
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                self._root = self._req({"op": "root"})
                return self._root
            except UnoError as exc:
                last = exc
                time.sleep(1.0)
        raise UnoError("worker did not become ready: %s" % last)

    def op_get(self, handle, name):
        return self._req({"op": "get", "h": handle, "name": name})

    def op_set(self, handle, name, value):
        self._req({"op": "set", "h": handle, "name": name, "v": encode(value)})

    def op_call(self, handle, name, args):
        encoded = [encode(a) for a in args]
        result = self._req({"op": "call", "h": handle, "name": name, "args": encoded})
        if name in ("storeToURL", "storeAsURL") and args:
            url = args[0]
            if isinstance(url, str) and url.startswith("file://"):
                wasm_path = url[7:]
                host = self._wasm_to_host.get(wasm_path)
                if host:
                    with open(host, "wb") as fh:
                        fh.write(self.read_file(wasm_path))
        return result

    def op_query(self, handle, iface):
        return self._req({"op": "query", "h": handle, "iface": iface})

    # ── file I/O (Wasm virtual filesystem) ───────────────────────────────
    def write_file(self, wasm_path, data):
        self._req({
            "op": "writeFile",
            "path": wasm_path,
            "data": base64.b64encode(data).decode("ascii"),
        })

    def read_file(self, wasm_path):
        result = self._req({"op": "readFile", "path": wasm_path})
        return base64.b64decode(result["data"])

    def register_output(self, host_path):
        base = os.path.basename(os.path.abspath(host_path))
        self._out_seq += 1
        wasm_path = "/tmp/uno_%d_%s" % (self._out_seq, base)
        self._wasm_to_host[wasm_path] = os.path.abspath(host_path)
        return "file://" + wasm_path

    def close(self):
        self.ws.close()
