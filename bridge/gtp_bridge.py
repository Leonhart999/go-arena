#!/usr/bin/env python3
"""Zero-dependency WebSocket-to-GTP bridge for go-arena.

Exposes any local GTP (Go Text Protocol) engine over ws://127.0.0.1:8765
so a browser running go-arena (e.g., hosted on GitHub Pages) can drive it.

Examples:
  python bridge/gtp_bridge.py -- python engines/random_gtp.py
  python bridge/gtp_bridge.py --port 8766 -- "D:\\AI\\projects\\go-ai\\go-ai.cmd" 2 noponder
  python bridge/gtp_bridge.py --cmd "katago gtp -model net.bin.gz -config gtp.cfg"
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import fnmatch
import hashlib
import json
import os
import queue
import shlex
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
DEFAULT_ORIGINS = [
    "http://localhost",
    "http://localhost:*",
    "https://localhost",
    "https://localhost:*",
    "http://127.0.0.1",
    "http://127.0.0.1:*",
    "https://127.0.0.1",
    "https://127.0.0.1:*",
    "http://[::1]",
    "http://[::1]:*",
    "https://*.github.io",
]


class GtpError(Exception):
    pass


def _is_windows() -> bool:
    return os.name == "nt"


class GtpProcess:
    """Manages one GTP child process with incremental board synchronization."""

    def __init__(self, command: str | list[str], cwd: str | None = None, quiet: bool = False):
        self.command = command
        self.cwd = cwd
        self.quiet = quiet
        self._lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self.info: dict = {}
        self.commands: set[str] = set()
        self.cur_size: int | None = None
        self.cur_komi: float | None = None
        self.cur_moves: list[list[str]] = []
        self.cur_time: float | None = None

    def _spawn(self) -> None:
        if isinstance(self.command, list):
            args: str | list[str] = subprocess.list2cmdline(self.command) if _is_windows() else self.command
        else:
            args = self.command if _is_windows() else shlex.split(self.command)

        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL if self.quiet else subprocess.PIPE,
            cwd=self.cwd,
            bufsize=0,
        )
        self._lines = queue.Queue()
        threading.Thread(target=self._pump_stdout, args=(self.proc, self._lines), daemon=True).start()
        if not self.quiet and self.proc.stderr is not None:
            threading.Thread(target=self._pump_stderr, args=(self.proc,), daemon=True).start()

        self.cur_size = None
        self.cur_komi = None
        self.cur_moves = []
        self.cur_time = None
        self.commands = set()

        name = self._try_send("name", timeout=180.0) or "GTP Engine"
        version = self._try_send("version", timeout=30.0) or ""
        listing = self._try_send("list_commands", timeout=30.0) or ""
        self.commands = {c.strip() for c in listing.splitlines() if c.strip()}
        self.info = {"name": name, "version": version, "commands": sorted(self.commands)}

    @staticmethod
    def _pump_stdout(proc: subprocess.Popen, out_q: queue.Queue) -> None:
        assert proc.stdout is not None
        for raw in iter(proc.stdout.readline, b""):
            out_q.put(raw.decode("utf-8", "replace").rstrip("\r\n"))
        out_q.put(None)

    @staticmethod
    def _pump_stderr(proc: subprocess.Popen) -> None:
        assert proc.stderr is not None
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line:
                print(f"[engine] {line}", file=sys.stderr, flush=True)

    def ensure_running(self) -> dict:
        with self._lock:
            if self.proc is None or self.proc.poll() is not None:
                self._spawn()
            return dict(self.info)

    def _send(self, command: str, timeout: float | None = 120.0) -> str:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            code = proc.returncode if proc else None
            raise GtpError(f"engine exited (code {code})")
        assert proc.stdin is not None
        try:
            proc.stdin.write((command + "\n").encode("utf-8"))
            proc.stdin.flush()
        except OSError as e:
            raise GtpError(f"cannot write to engine: {e}")

        deadline = None if timeout is None else time.monotonic() + timeout
        status = None
        body: list[str] = []
        while True:
            remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
            try:
                line = self._lines.get(timeout=remaining)
            except queue.Empty:
                raise GtpError(f"timeout waiting for {command!r}")
            if line is None:
                raise GtpError(f"engine closed stdout during {command!r}")
            if status is None:
                if line.startswith(("=", "?")):
                    status = line[0]
                    body.append(line[1:].lstrip("0123456789").strip())
                continue
            if line.strip() == "":
                break
            body.append(line)

        text = "\n".join(body).strip()
        if status == "?":
            raise GtpError(f"{command!r} failed: {text}")
        return text

    def _try_send(self, command: str, timeout: float | None = 30.0) -> str | None:
        try:
            return self._send(command, timeout=timeout)
        except GtpError:
            return None

    def _sync_state(self, size: int, komi: float, moves: list[list[str]], time_per_move: float) -> None:
        norm_moves = [[str(c).upper(), str(v)] for c, v in moves]
        prefix_ok = (
            self.cur_size == size
            and self.cur_komi == komi
            and len(norm_moves) >= len(self.cur_moves)
            and norm_moves[: len(self.cur_moves)] == self.cur_moves
        )
        if not prefix_ok:
            if self.cur_size != size:
                self._send(f"boardsize {size}", timeout=30.0)
                self.cur_size = size
            self._send("clear_board", timeout=30.0)
            self._send(f"komi {komi:g}", timeout=30.0)
            self.cur_komi = komi
            self.cur_moves = []
            self.cur_time = None

        for color, vertex in norm_moves[len(self.cur_moves) :]:
            self._send(f"play {color} {vertex}", timeout=30.0)
            self.cur_moves.append([color, vertex])

        if "time_settings" in self.commands and time_per_move != self.cur_time:
            if time_per_move > 0:
                sec = max(1, int(time_per_move))
                self._try_send(f"time_settings 0 {sec} 1", timeout=10.0)
            elif self.cur_time is not None:
                self._try_send("time_settings 0 0 0", timeout=10.0)
            self.cur_time = time_per_move

    def genmove(self, size: int, komi: float, color: str, moves: list[list[str]], time_per_move: float) -> str:
        with self._lock:
            if self.proc is None or self.proc.poll() is not None:
                self._spawn()
            self._sync_state(size, komi, moves, time_per_move)
            c = str(color).upper()
            if time_per_move > 0 and "time_left" in self.commands:
                sec = max(1, int(time_per_move))
                self._try_send(f"time_left {c} {sec} 1", timeout=10.0)
            think_timeout = max(30.0, time_per_move + 30.0) if time_per_move > 0 else 600.0
            move = self._send(f"genmove {c}", timeout=think_timeout)
            mv = move.strip()
            if mv.lower() != "resign":
                self.cur_moves.append([c, mv])
            return mv

    def final_score(self, size: int, komi: float, moves: list[list[str]]) -> str:
        with self._lock:
            if self.proc is None or self.proc.poll() is not None:
                self._spawn()
            self._sync_state(size, komi, moves, 0.0)
            return self._send("final_score", timeout=60.0)

    def kill(self) -> None:
        proc = self.proc
        if proc is None:
            return
        if proc.poll() is None:
            if _is_windows():
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass
        self.proc = None

    def restart(self) -> dict:
        self.kill()
        return self.ensure_running()


# ---------------------------------------------------------------------------
# Minimal RFC 6455 WebSocket server (stdlib only)
# ---------------------------------------------------------------------------
def origin_allowed(origin: str | None, patterns: list[str]) -> bool:
    if not origin:
        return True
    if "*" in patterns:
        return True
    parsed = urlparse(origin)
    normalized = f"{parsed.scheme}://{parsed.netloc}".lower() if parsed.scheme and parsed.netloc else origin.lower()
    for pat in patterns:
        p = pat.strip().lower()
        if fnmatch.fnmatch(normalized, p) or fnmatch.fnmatch(origin.lower(), p):
            return True
    return False


async def ws_read_message(reader: asyncio.StreamReader, send_frame) -> tuple[int, bytes] | None:
    """Read a complete (possibly fragmented) WebSocket message, handling interleaved control frames."""
    chunks: list[bytes] = []
    first_opcode = None
    while True:
        try:
            header = await reader.readexactly(2)
        except asyncio.IncompleteReadError:
            return None
        b1, b2 = header[0], header[1]
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", await reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await reader.readexactly(8))[0]
        mask_key = await reader.readexactly(4) if masked else b""
        payload = await reader.readexactly(length)
        if masked:
            payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))

        if opcode == 0x8:  # close
            return opcode, payload
        if opcode == 0x9:  # ping
            await send_frame(0xA, payload)
            continue
        if opcode == 0xA:  # pong
            continue

        if first_opcode is None:
            first_opcode = opcode
        chunks.append(payload)
        if fin:
            return first_opcode, b"".join(chunks)


def ws_encode_frame(opcode: int, payload: bytes) -> bytes:
    n = len(payload)
    first = 0x80 | (opcode & 0x0F)
    if n < 126:
        header = bytes([first, n])
    elif n < 65536:
        header = struct.pack("!BBH", first, 126, n)
    else:
        header = struct.pack("!BBQ", first, 127, n)
    return header + payload


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    engine: GtpProcess,
    allowed_origins: list[str],
) -> None:
    write_lock = asyncio.Lock()

    async def send_frame(opcode: int, data: bytes) -> None:
        async with write_lock:
            writer.write(ws_encode_frame(opcode, data))
            await writer.drain()

    async def send_json(obj: dict) -> None:
        await send_frame(0x1, json.dumps(obj).encode("utf-8"))

    try:
        raw_req = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
    except Exception:
        writer.close()
        return

    lines = raw_req.decode("utf-8", "replace").split("\r\n")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    origin = headers.get("origin")
    if not origin_allowed(origin, allowed_origins):
        print(f"[bridge] Rejected origin: {origin}", file=sys.stderr, flush=True)
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 17\r\n\r\nOrigin not allowed")
        await writer.drain()
        writer.close()
        return

    ws_key = headers.get("sec-websocket-key")
    if not ws_key:
        writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\n\r\nBad Request")
        await writer.drain()
        writer.close()
        return

    accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    writer.write(resp.encode("ascii"))
    await writer.drain()
    print(f"[bridge] Client connected (origin={origin or 'none'})", flush=True)

    async def dispatch(msg: dict) -> None:
        req_id = msg.get("id")
        op = msg.get("op")
        try:
            if op == "hello":
                info = await asyncio.to_thread(engine.ensure_running)
                await send_json({"id": req_id, "ok": True, **info})
            elif op == "genmove":
                move = await asyncio.to_thread(
                    engine.genmove,
                    int(msg["size"]),
                    float(msg["komi"]),
                    str(msg["color"]),
                    list(msg.get("moves", [])),
                    float(msg.get("timePerMove", 0)),
                )
                await send_json({"id": req_id, "ok": True, "move": move})
            elif op == "final_score":
                score = await asyncio.to_thread(
                    engine.final_score,
                    int(msg["size"]),
                    float(msg["komi"]),
                    list(msg.get("moves", [])),
                )
                await send_json({"id": req_id, "ok": True, "score": score})
            elif op == "restart":
                await asyncio.to_thread(engine.restart)
                await send_json({"id": req_id, "ok": True})
            else:
                await send_json({"id": req_id, "ok": False, "error": f"unknown op {op!r}"})
        except Exception as e:
            await send_json({"id": req_id, "ok": False, "error": str(e)})

    tasks: set[asyncio.Task] = set()
    try:
        while True:
            frame = await ws_read_message(reader, send_frame)
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 0x8:  # close
                try:
                    await send_frame(0x8, payload[:2])
                except OSError:
                    pass
                break
            if opcode != 0x1:
                continue
            try:
                msg = json.loads(payload.decode("utf-8"))
            except json.JSONDecodeError:
                continue
            task = asyncio.create_task(dispatch(msg))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        for t in list(tasks):
            t.cancel()
        writer.close()
        print("[bridge] Client disconnected", flush=True)


async def run_server(host: str, port: int, engine: GtpProcess, allowed_origins: list[str], preload: bool) -> None:
    if preload:
        print("[bridge] Starting GTP engine ...", flush=True)
        info = await asyncio.to_thread(engine.ensure_running)
        print(f"[bridge] Engine ready: {info.get('name')} {info.get('version')}".strip(), flush=True)

    server = await asyncio.start_server(
        lambda r, w: handle_client(r, w, engine, allowed_origins),
        host,
        port,
    )
    print(f"[bridge] Listening on ws://{host}:{port}", flush=True)
    async with server:
        await server.serve_forever()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Expose a local GTP Go engine to go-arena over WebSocket.")
    p.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    p.add_argument("--port", type=int, default=8765, help="WebSocket port (default: 8765)")
    p.add_argument("--cmd", help="GTP engine command string")
    p.add_argument("--cwd", help="Working directory for the engine process")
    p.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        help="Extra allowed Origin pattern (repeatable, or '*' for any)",
    )
    p.add_argument("--no-preload", action="store_true", help="Start the engine on first browser connection instead of immediately")
    p.add_argument("--quiet", action="store_true", help="Suppress engine stderr output")
    p.add_argument("command", nargs=argparse.REMAINDER, help="GTP engine command after '--'")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cmd_parts = list(args.command)
    if cmd_parts and cmd_parts[0] == "--":
        cmd_parts = cmd_parts[1:]

    if args.cmd and cmd_parts:
        print("Error: specify either --cmd or a trailing command, not both.", file=sys.stderr)
        return 2
    if args.cmd:
        command: str | list[str] = args.cmd
    elif cmd_parts:
        command = cmd_parts
    else:
        print("Error: missing GTP engine command. Example: python bridge/gtp_bridge.py -- python engines/random_gtp.py", file=sys.stderr)
        return 2

    allowed = DEFAULT_ORIGINS + args.allow_origin
    engine = GtpProcess(command, cwd=args.cwd, quiet=args.quiet)
    try:
        asyncio.run(run_server(args.host, args.port, engine, allowed, preload=not args.no_preload))
    except KeyboardInterrupt:
        print("\n[bridge] Shutting down.", flush=True)
    finally:
        engine.kill()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
