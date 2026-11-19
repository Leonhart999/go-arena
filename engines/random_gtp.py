#!/usr/bin/env python3
"""Minimal dependency-free GTP v2 Go engine (random legal moves).

Use this both as a smoke-test opponent and as a template for wrapping your
own Python offline model into a GTP engine for go-arena.
"""

from __future__ import annotations

import random
import sys

EMPTY, BLACK, WHITE = 0, 1, 2
GTP_COLS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"  # GTP skips I


def other(color: int) -> int:
    return BLACK + WHITE - color


def parse_color(text: str) -> int:
    t = text.strip().upper()
    if t in ("B", "BLACK"):
        return BLACK
    if t in ("W", "WHITE"):
        return WHITE
    raise ValueError(f"invalid color {text!r}")


class SimpleBoard:
    def __init__(self, size: int = 19):
        self.size = size
        self.komi = 7.5
        self.stones = [EMPTY] * (size * size)
        self.ko_point: int | None = None
        self.history: set[tuple[int, ...]] = {tuple(self.stones)}
        self._nbrs = self._build_nbrs(size)

    @staticmethod
    def _build_nbrs(size: int) -> list[list[int]]:
        nbrs = []
        for p in range(size * size):
            r, c = divmod(p, size)
            nb = []
            if r > 0:
                nb.append(p - size)
            if r < size - 1:
                nb.append(p + size)
            if c > 0:
                nb.append(p - 1)
            if c < size - 1:
                nb.append(p + 1)
            nbrs.append(nb)
        return nbrs

    def from_gtp(self, vertex: str) -> int | None:
        v = vertex.strip().upper()
        if v == "PASS":
            return None
        col = GTP_COLS.index(v[0])
        row = self.size - int(v[1:])
        if not (0 <= col < self.size and 0 <= row < self.size):
            raise ValueError(f"vertex out of range: {vertex}")
        return row * self.size + col

    def to_gtp(self, point: int | None) -> str:
        if point is None:
            return "pass"
        r, c = divmod(point, self.size)
        return f"{GTP_COLS[c]}{self.size - r}"

    def _group(self, start: int) -> tuple[list[int], bool]:
        color = self.stones[start]
        seen = {start}
        stack = [start]
        has_lib = False
        while stack:
            p = stack.pop()
            for q in self._nbrs[p]:
                s = self.stones[q]
                if s == EMPTY:
                    has_lib = True
                elif s == color and q not in seen:
                    seen.add(q)
                    stack.append(q)
        return list(seen), has_lib

    def play(self, color: int, point: int | None) -> None:
        if point is None:
            self.ko_point = None
            return
        if self.stones[point] != EMPTY:
            raise ValueError("point occupied")
        if point == self.ko_point:
            raise ValueError("ko violation")

        opp = other(color)
        self.stones[point] = color
        captured: list[int] = []
        for q in self._nbrs[point]:
            if self.stones[q] == opp:
                chain, alive = self._group(q)
                if not alive:
                    for s in chain:
                        if self.stones[s] == opp:
                            self.stones[s] = EMPTY
                            captured.append(s)
        _, alive = self._group(point)
        if not alive:
            self.stones[point] = EMPTY
            raise ValueError("suicide")

        key = tuple(self.stones)
        if key in self.history:
            for s in captured:
                self.stones[s] = opp
            self.stones[point] = EMPTY
            raise ValueError("superko")
        self.history.add(key)

        self.ko_point = None
        if len(captured) == 1:
            chain, _ = self._group(point)
            libs = [q for q in self._nbrs[point] if self.stones[q] == EMPTY]
            if len(chain) == 1 and len(libs) == 1:
                self.ko_point = captured[0]

    def is_legal(self, color: int, point: int) -> bool:
        if self.stones[point] != EMPTY or point == self.ko_point:
            return False
        saved_stones = self.stones[:]
        saved_ko = self.ko_point
        saved_hist = self.history
        self.history = set(saved_hist)
        try:
            self.play(color, point)
            return True
        except ValueError:
            return False
        finally:
            self.stones = saved_stones
            self.ko_point = saved_ko
            self.history = saved_hist

    def is_obvious_eye(self, color: int, point: int) -> bool:
        for q in self._nbrs[point]:
            if self.stones[q] != color:
                return False
        r, c = divmod(point, self.size)
        opp = other(color)
        diag_opp = 0
        diags = 0
        for dr in (-1, 1):
            for dc in (-1, 1):
                nr, nc = r + dr, c + dc
                if 0 <= nr < self.size and 0 <= nc < self.size:
                    diags += 1
                    if self.stones[nr * self.size + nc] == opp:
                        diag_opp += 1
        return diag_opp <= (0 if diags < 4 else 1)

    def pick_move(self, color: int) -> int | None:
        candidates = [p for p in range(len(self.stones)) if self.stones[p] == EMPTY and not self.is_obvious_eye(color, p)]
        random.shuffle(candidates)
        for p in candidates:
            if self.is_legal(color, p):
                return p
        return None

    def final_score(self) -> str:
        black = white = 0
        seen = [False] * len(self.stones)
        for i, s in enumerate(self.stones):
            if s == BLACK:
                black += 1
            elif s == WHITE:
                white += 1
            elif not seen[i]:
                region, borders = [], set()
                stack = [i]
                seen[i] = True
                while stack:
                    p = stack.pop()
                    region.append(p)
                    for q in self._nbrs[p]:
                        t = self.stones[q]
                        if t == EMPTY:
                            if not seen[q]:
                                seen[q] = True
                                stack.append(q)
                        else:
                            borders.add(t)
                if borders == {BLACK}:
                    black += len(region)
                elif borders == {WHITE}:
                    white += len(region)
        diff = black - white - self.komi
        if diff == 0:
            return "0"
        return f"B+{diff:g}" if diff > 0 else f"W+{-diff:g}"


class RandomGtpEngine:
    COMMANDS = [
        "protocol_version",
        "name",
        "version",
        "known_command",
        "list_commands",
        "quit",
        "boardsize",
        "clear_board",
        "komi",
        "play",
        "genmove",
        "final_score",
    ]

    def __init__(self) -> None:
        self.board = SimpleBoard(19)

    def handle(self, line: str) -> tuple[bool, str, bool]:
        """Returns (ok, body, should_quit)."""
        parts = line.strip().split()
        if not parts:
            return True, "", False
        cmd, args = parts[0].lower(), parts[1:]

        if cmd == "protocol_version":
            return True, "2", False
        if cmd == "name":
            return True, "random_gtp", False
        if cmd == "version":
            return True, "0.1", False
        if cmd == "known_command":
            return True, "true" if (args and args[0].lower() in self.COMMANDS) else "false", False
        if cmd == "list_commands":
            return True, "\n".join(self.COMMANDS), False
        if cmd == "quit":
            return True, "", True
        if cmd == "boardsize":
            size = int(args[0])
            if not (2 <= size <= 25):
                return False, "unacceptable size", False
            komi = self.board.komi
            self.board = SimpleBoard(size)
            self.board.komi = komi
            return True, "", False
        if cmd == "clear_board":
            komi = self.board.komi
            self.board = SimpleBoard(self.board.size)
            self.board.komi = komi
            return True, "", False
        if cmd == "komi":
            self.board.komi = float(args[0])
            return True, "", False
        if cmd == "play":
            color = parse_color(args[0])
            pt = self.board.from_gtp(args[1])
            self.board.play(color, pt)
            return True, "", False
        if cmd == "genmove":
            color = parse_color(args[0])
            pt = self.board.pick_move(color)
            if pt is not None:
                self.board.play(color, pt)
            return True, self.board.to_gtp(pt), False
        if cmd == "final_score":
            return True, self.board.final_score(), False
        return False, "unknown command", False


def main() -> int:
    engine = RandomGtpEngine()
    for raw in sys.stdin:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        cmd_id = ""
        tokens = line.split()
        if tokens[0].isdigit():
            cmd_id = tokens[0]
            line = " ".join(tokens[1:])
        try:
            ok, body, quit_now = engine.handle(line)
        except Exception as e:
            ok, body, quit_now = False, str(e), False
        prefix = "=" if ok else "?"
        head = f"{prefix}{cmd_id}"
        out = f"{head} {body}".rstrip() if body else head
        sys.stdout.write(out + "\n\n")
        sys.stdout.flush()
        if quit_now:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
