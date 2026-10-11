"""A small Source RCON client (the protocol Minecraft servers speak with `enable-rcon=true`), stdlib sockets only.

Packet: int32 length (of the rest), int32 request id, int32 type, ASCII body, two NUL bytes; little endian.
Types: 3 = login (body: the password), 2 = command (client → server) and login answer (server → client), 0 = command
output. A login answer with id -1 means a wrong password. Minecraft answers every command with one packet (output up
to 4096 bytes; our commands print short lines) and accepts command bodies up to 1446 bytes.

    with Rcon(host, port, timeout_s) as r:
        r.login(password)            # RconError("auth") on a wrong password
        r.command("say hi")          # → the server's reply text

`send_all()` runs a whole command list in batches (a short pause between batches keeps a busy server responsive) and
counts the replies that look like command errors. The password is only ever written to the socket: it is never
logged, echoed, stored or put in an error message.
"""
from __future__ import annotations

import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Iterable

LOGIN, COMMAND, OUTPUT = 3, 2, 0
MAX_BODY = 1446
MAX_PACKET = 4096 + 14
BATCH = 50
PAUSE_S = 0.05
ERROR_HINTS = ("<--[HERE]", "Unknown or incomplete command", "Incorrect argument", "Invalid", "Could not",
               "No entity was found", "No player was found", "That position is not loaded", "Expected ")


class RconError(Exception):
    """code: unreachable (no connection, timeout) | auth (wrong password) | failed (the connection broke)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def encode(req_id: int, kind: int, body: str) -> bytes:
    data = body.encode("utf-8")
    return struct.pack("<iii", len(data) + 10, req_id, kind) + data + b"\x00\x00"


class Rcon:
    def __init__(self, host: str, port: int, timeout_s: float = 5.0) -> None:
        self.host, self.port, self.timeout_s = host, int(port), float(timeout_s)
        self.sock: socket.socket | None = None
        self._next = 0

    def __enter__(self) -> "Rcon":
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout_s)
        except (OSError, ValueError):
            raise RconError("unreachable") from None
        self.sock.settimeout(self.timeout_s)
        return self

    def __exit__(self, *exc: object) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _recv_exact(self, n: int) -> bytes:
        assert self.sock is not None
        buf = b""
        while len(buf) < n:
            try:
                chunk = self.sock.recv(n - len(buf))
            except (OSError, socket.timeout):
                raise RconError("failed") from None
            if not chunk:
                raise RconError("failed")
            buf += chunk
        return buf

    def _read(self) -> tuple[int, int, str]:
        (length,) = struct.unpack("<i", self._recv_exact(4))
        if length < 10 or length > MAX_PACKET:
            raise RconError("failed")
        data = self._recv_exact(length)
        req_id, kind = struct.unpack("<ii", data[:8])
        return req_id, kind, data[8:-2].decode("utf-8", "replace")

    def _send(self, kind: int, body: str) -> int:
        assert self.sock is not None
        self._next += 1
        try:
            self.sock.sendall(encode(self._next, kind, body))
        except OSError:
            raise RconError("failed") from None
        return self._next

    def login(self, password: str) -> None:
        rid = self._send(LOGIN, password)
        while True:  # Source servers send an empty output packet before the login answer; Minecraft does not
            got, kind, _ = self._read()
            if kind == COMMAND:
                if got == -1 or got != rid:
                    raise RconError("auth")
                return

    def command(self, cmd: str) -> str:
        rid = self._send(COMMAND, cmd)
        while True:
            got, kind, body = self._read()
            if got == rid:
                return body


def looks_failed(reply: str) -> bool:
    return any(h in reply for h in ERROR_HINTS)


@dataclass
class SendResult:
    sent: int = 0
    failed: int = 0
    replies: list[str] = field(default_factory=list)  # the first few error replies (never the password)


def send_all(host: str, port: int, password: str, commands: Iterable[str], *, timeout_s: float = 5.0,
             batch: int = BATCH, pause_s: float = PAUSE_S, must_work: int | None = None) -> SendResult:
    """Log in and run every command; raises RconError (unreachable | auth | failed | no_player). When the command at
    index `must_work` fails (the origin marker: no player online) the build stops there."""
    out = SendResult()
    with Rcon(host, port, timeout_s) as r:
        r.login(password)
        for i, cmd in enumerate(commands):
            if len(cmd.encode("utf-8")) > MAX_BODY:
                out.failed += 1
                continue
            reply = r.command(cmd)
            out.sent += 1
            if looks_failed(reply):
                out.failed += 1
                if len(out.replies) < 5:
                    out.replies.append(reply[:200])
                if i == must_work:
                    raise RconError("no_player")
            if batch and out.sent % batch == 0:
                time.sleep(pause_s)
    return out
