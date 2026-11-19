#!/usr/bin/env python3
"""Tests for random_gtp.py and gtp_bridge.py (stdlib only)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(ROOT / "engines"))

import gtp_bridge  # noqa: E402
import random_gtp  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class WsTestClient:
    """Minimal masked WebSocket client using stdlib sockets."""

    def __init__(self, host: str, port: int, origin: str = "http://127.0.0.1:8000"):
        self.sock = socket.create_connection((host, port), timeout=10.0)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        try:
            req = (
                f"GET / HTTP/1.1\r\n"
                f"Host: {host}:{port}\r\n"
                f"Upgrade: websocket\r\n"
                f"Connection: Upgrade\r\n"
                f"Origin: {origin}\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n\r\n"
            )
            self.sock.sendall(req.encode("ascii"))
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = self.sock.recv(4096)
                if not chunk:
                    raise ConnectionError("EOF during handshake")
                buf += chunk
            head, self._extra = buf.split(b"\r\n\r\n", 1)
            status_line = head.split(b"\r\n", 1)[0].decode("ascii", "replace")
            if "101" not in status_line:
                raise PermissionError(status_line)
            expected = base64.b64encode(hashlib.sha1((key + gtp_bridge.WS_GUID).encode("ascii")).digest()).decode("ascii")
            if expected.encode("ascii") not in head:
                raise AssertionError("Bad Sec-WebSocket-Accept")
        except Exception:
            self.sock.close()
            raise

    def _recv_exact(self, n: int) -> bytes:
        out = bytearray()
        if self._extra:
            take = min(n, len(self._extra))
            out.extend(self._extra[:take])
            self._extra = self._extra[take:]
        while len(out) < n:
            chunk = self.sock.recv(n - len(out))
            if not chunk:
                raise EOFError("WebSocket closed")
            out.extend(chunk)
        return bytes(out)

    def send_json(self, obj: dict) -> None:
        payload = json.dumps(obj).encode("utf-8")
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = bytes([0x81, 0x80 | n])
        elif n < 65536:
            header = struct.pack("!BBH", 0x81, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def recv_json(self) -> dict:
        b1, b2 = self._recv_exact(2)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        payload = self._recv_exact(length)
        return json.loads(payload.decode("utf-8"))

    def call(self, op: str, **params) -> dict:
        req_id = params.pop("id", 1)
        self.send_json({"id": req_id, "op": op, **params})
        return self.recv_json()

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class RandomGtpTests(unittest.TestCase):
    def test_gtp_protocol_and_scoring(self):
        eng = random_gtp.RandomGtpEngine()
        self.assertEqual(eng.handle("protocol_version"), (True, "2", False))
        self.assertEqual(eng.handle("name"), (True, "random_gtp", False))
        self.assertEqual(eng.handle("boardsize 5"), (True, "", False))
        self.assertEqual(eng.handle("komi 2.5"), (True, "", False))
        ok, mv, _ = eng.handle("genmove B")
        self.assertTrue(ok)
        self.assertNotEqual(mv, "")
        ok, score, _ = eng.handle("final_score")
        self.assertTrue(ok)
        self.assertTrue(score.startswith(("B+", "W+", "0")))
        self.assertEqual(eng.handle("quit"), (True, "", True))


class BridgeTests(unittest.TestCase):
    def test_origin_filter(self):
        patterns = gtp_bridge.DEFAULT_ORIGINS
        self.assertTrue(gtp_bridge.origin_allowed("https://leonhart999.github.io", patterns))
        self.assertTrue(gtp_bridge.origin_allowed("http://127.0.0.1:8080", patterns))
        self.assertTrue(gtp_bridge.origin_allowed("http://localhost:5173", patterns))
        self.assertFalse(gtp_bridge.origin_allowed("https://evil.example.com", patterns))
        self.assertTrue(gtp_bridge.origin_allowed("https://evil.example.com", patterns + ["*"]))

    def test_websocket_bridge_full_game_and_restart(self):
        port = free_port()
        engine = gtp_bridge.GtpProcess([sys.executable, str(ROOT / "engines" / "random_gtp.py")], quiet=True)
        loop_holder: dict = {}
        ready = threading.Event()

        async def runner():
            loop_holder["loop"] = asyncio.get_running_loop()
            await asyncio.to_thread(engine.ensure_running)
            server = await asyncio.start_server(
                lambda r, w: gtp_bridge.handle_client(r, w, engine, gtp_bridge.DEFAULT_ORIGINS),
                "127.0.0.1",
                port,
            )
            loop_holder["server"] = server
            ready.set()
            try:
                async with server:
                    await server.serve_forever()
            except asyncio.CancelledError:
                pass

        th = threading.Thread(target=lambda: asyncio.run(runner()), daemon=True)
        th.start()
        self.assertTrue(ready.wait(timeout=10.0))

        try:
            # Disallowed origin is rejected with 403
            with self.assertRaises(PermissionError):
                WsTestClient("127.0.0.1", port, origin="https://untrusted.example.com")

            # Allowed GitHub Pages origin connects
            client = WsTestClient("127.0.0.1", port, origin="https://leonhart999.github.io")
            try:
                hello = client.call("hello", id=1)
                self.assertTrue(hello["ok"])
                self.assertEqual(hello["name"], "random_gtp")
                self.assertIn("final_score", hello["commands"])

                # Play a quick 3x3 game via incremental sync
                moves = []
                color = "B"
                passes = 0
                for step in range(30):
                    res = client.call("genmove", id=10 + step, size=3, komi=2.5, color=color, moves=moves, timePerMove=2)
                    self.assertTrue(res["ok"], res)
                    mv = res["move"]
                    moves.append([color, mv])
                    passes = passes + 1 if mv.lower() == "pass" else 0
                    color = "W" if color == "B" else "B"
                    if passes >= 2:
                        break
                self.assertGreater(len(moves), 2)

                score = client.call("final_score", id=99, size=3, komi=2.5, moves=moves)
                self.assertTrue(score["ok"])
                self.assertTrue(score["score"].startswith(("B+", "W+", "0")))

                # New game on different board size resets cleanly
                g2 = client.call("genmove", id=100, size=5, komi=6.5, color="B", moves=[], timePerMove=0)
                self.assertTrue(g2["ok"])

                # Restart recovers engine
                rst = client.call("restart", id=101)
                self.assertTrue(rst["ok"])
                g3 = client.call("genmove", id=102, size=5, komi=6.5, color="B", moves=[], timePerMove=0)
                self.assertTrue(g3["ok"])
            finally:
                client.close()
        finally:
            loop_holder["loop"].call_soon_threadsafe(loop_holder["server"].close)
            engine.kill()
            th.join(timeout=5.0)


if __name__ == "__main__":
    unittest.main()
