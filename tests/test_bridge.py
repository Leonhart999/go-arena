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
    def test_parse_analyze_line_kata_and_lz(self):
        # White to play: winrate 0.30 for White -> 0.70 for Black; scoreLead -2.5 -> +2.5 for Black; ownership flipped.
        kata_line = (
            "info move D4 visits 120 winrate 0.3000 scoreLead -2.50 order 0 pv D4 Q16 D16 "
            "info move Q4 visits 40 winrate 0.2500 scoreLead -3.40 order 1 pv Q4 C16 "
            "ownership -0.8 0.2 0.5 -0.9"
        )
        res = gtp_bridge.parse_analyze_line(kata_line, "W", "kata", 2)
        self.assertIsNotNone(res)
        self.assertAlmostEqual(res["winrate"], 0.7, places=4)
        self.assertAlmostEqual(res["scoreLead"], 2.5, places=2)
        self.assertEqual(res["visits"], 160)
        self.assertEqual(res["ownership"], [0.8, -0.2, -0.5, 0.9])
        self.assertEqual(res["moves"][0]["move"], "D4")
        self.assertEqual(res["moves"][0]["pv"], ["D4", "Q16", "D16"])
        self.assertEqual(len(res["moves"]), 2)

        # lz-analyze uses 0..10000 integer winrates and no scoreLead/ownership
        lz_line = "info move C3 visits 85 winrate 6250 order 0 pv C3 D4 info move D3 visits 20 winrate 5900 order 1 pv D3 C4"
        res_lz = gtp_bridge.parse_analyze_line(lz_line, "B", "lz", 5)
        self.assertIsNotNone(res_lz)
        self.assertAlmostEqual(res_lz["winrate"], 0.625, places=4)
        self.assertIsNone(res_lz["scoreLead"])
        self.assertIsNone(res_lz["ownership"])
        self.assertEqual(res_lz["visits"], 105)
        self.assertEqual(res_lz["moves"][0]["move"], "C3")

    def test_analyze_streaming_and_cancel_over_websocket(self):
        # Inline mock GTP engine supporting kata-analyze streaming
        mock_code = (
            "import sys, time\n"
            "for raw in sys.stdin:\n"
            "    s = raw.strip()\n"
            "    if not s: continue\n"
            "    p = s.split()\n"
            "    cmd = p[0].lower()\n"
            "    if cmd == 'name': out = '= mock_kata\\n\\n'\n"
            "    elif cmd == 'version': out = '= 1.0\\n\\n'\n"
            "    elif cmd == 'list_commands': out = '= name\\nversion\\nboardsize\\nclear_board\\nkomi\\nplay\\ngenmove\\nfinal_score\\nkata-analyze\\n\\n'\n"
            "    elif cmd in ('boardsize','clear_board','komi','play'): out = '=\\n\\n'\n"
            "    elif cmd == 'final_score': out = '= B+1.5\\n\\n'\n"
            "    elif cmd == 'kata-analyze':\n"
            "        sys.stdout.write('=\\n')\n"
            "        sys.stdout.write('info move B2 visits 30 winrate 0.62 scoreLead 1.8 order 0 pv B2 C3 ownership 0.5 0.4 0.1 -0.2 -0.5 -0.3 0.2 0.3 0.1\\n')\n"
            "        sys.stdout.flush()\n"
            "        # Wait for blank line to stop streaming\n"
            "        while True:\n"
            "            nxt = sys.stdin.readline()\n"
            "            if not nxt or nxt.strip() == '':\n"
            "                sys.stdout.write('\\n')\n"
            "                sys.stdout.flush()\n"
            "                break\n"
            "        continue\n"
            "    elif cmd == 'quit':\n"
            "        sys.stdout.write('=\\n\\n'); sys.stdout.flush(); break\n"
            "    else: out = '? unknown\\n\\n'\n"
            "    sys.stdout.write(out); sys.stdout.flush()\n"
        )
        port = free_port()
        engine = gtp_bridge.GtpProcess([sys.executable, "-u", "-c", mock_code], quiet=True)
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
            client = WsTestClient("127.0.0.1", port)
            try:
                hello = client.call("hello", id=1)
                self.assertTrue(hello["ok"])
                self.assertTrue(hello["canScore"])
                self.assertTrue(hello["canAnalyze"])
                self.assertEqual(hello["analyzeProto"], "kata")

                an = client.call("analyze", id=2, size=3, komi=2.5, color="B", moves=[], maxTimeMs=150, maxMoves=3, includeOwnership=True)
                self.assertTrue(an["ok"], an)
                self.assertAlmostEqual(an["winrate"], 0.62, places=3)
                self.assertAlmostEqual(an["scoreLead"], 1.8, places=2)
                self.assertEqual(len(an["ownership"]), 9)
                self.assertEqual(an["moves"][0]["move"], "B2")

                # Engine remains responsive after analyze stops
                sc = client.call("final_score", id=3, size=3, komi=2.5, moves=[])
                self.assertTrue(sc["ok"])
                self.assertEqual(sc["score"], "B+1.5")
            finally:
                client.close()
        finally:
            loop_holder["loop"].call_soon_threadsafe(loop_holder["server"].close)
            engine.kill()
            th.join(timeout=5.0)

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
