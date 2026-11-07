"""A tiny dependency-free synchronous WebSocket text client.

Only what the UNO bridge needs: a blocking connect, send a text frame, receive
a text frame. Client-to-server frames are masked per RFC 6455; ping frames are
answered with pong; close frames raise.
"""

import base64
import os
import socket
import struct


class WSClient:
    def __init__(self, url, timeout=600):
        if not url.startswith("ws://"):
            raise ValueError("only ws:// URLs are supported: %r" % url)
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        path = "/" + path if path else "/"
        host, _, port = hostport.partition(":")
        port = int(port or 80)
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        self._handshake(host, port, path)

    def _handshake(self, host, port, path):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ) % (path, host, port, key)
        self.sock.sendall(req.encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake failed (connection closed)")
            data += chunk
        status = data.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise RuntimeError("websocket handshake failed: " + status.decode("latin1", "replace"))
        _, _, extra = data.partition(b"\r\n\r\n")
        self._buf = extra

    def send_text(self, text):
        payload = text.encode("utf-8")
        header = bytearray([0x81])  # FIN + text opcode
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i & 3]
        self.sock.sendall(bytes(header) + bytes(masked))

    def _send_control(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        n = len(payload)
        header.append(0x80 | n)
        mask = os.urandom(4)
        header += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i & 3]
        self.sock.sendall(bytes(header) + bytes(masked))

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("websocket connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def recv_text(self):
        while True:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else None
            payload = self._recv_exact(ln) if ln else b""
            if mask:
                payload = bytes(payload[i] ^ mask[i & 3] for i in range(len(payload)))
            if opcode == 0x8:  # close
                self.close()
                raise RuntimeError("websocket closed by server")
            if opcode == 0x9:  # ping
                self._send_control(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x1:  # text
                return payload.decode("utf-8")
            # continuation/other -> ignore

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass
