"""A tiny fake Minecraft RCON server in a thread (Source RCON framing): checks the password, records every command
and answers like Minecraft (empty output, or an error line for commands it is told to reject)."""
from __future__ import annotations

import socket
import struct
import threading
from typing import Callable


class FakeRcon:
    def __init__(self, password: str = "hunter2", reject: Callable[[str], bool] | None = None) -> None:
        self.password = password
        self.reject = reject or (lambda cmd: False)
        self.commands: list[str] = []
        self.logins: list[bool] = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self) -> "FakeRcon":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self.thread.join(2)
        self.sock.close()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except (socket.timeout, OSError):
                continue
            with conn:
                conn.settimeout(2)
                try:
                    self._handle(conn)
                except (OSError, struct.error):
                    pass

    @staticmethod
    def _recv(conn: socket.socket, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                raise OSError("closed")
            buf += chunk
        return buf

    @staticmethod
    def _send(conn: socket.socket, req_id: int, kind: int, body: str) -> None:
        data = body.encode("utf-8")
        conn.sendall(struct.pack("<iii", len(data) + 10, req_id, kind) + data + b"\x00\x00")

    def _handle(self, conn: socket.socket) -> None:
        authed = False
        while not self._stop.is_set():
            (length,) = struct.unpack("<i", self._recv(conn, 4))
            data = self._recv(conn, length)
            req_id, kind = struct.unpack("<ii", data[:8])
            body = data[8:-2].decode("utf-8")
            if kind == 3:
                authed = body == self.password
                self.logins.append(authed)
                self._send(conn, req_id if authed else -1, 2, "")
                if not authed:
                    return
            elif kind == 2 and authed:
                self.commands.append(body)
                self._send(conn, req_id, 0, "Unknown or incomplete command, see below for error" if self.reject(body)
                           else "")
