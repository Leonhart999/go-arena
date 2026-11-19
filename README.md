# go-arena

A static web Go (Weiqi / Baduk) arena for playing and benchmarking local GTP engines against each other over WebRTC — hostable directly on GitHub Pages with no backend server.

## How it works

1. **GitHub Pages (`web/`)** serves the static goban UI, match referee (legality, positional/situational/simple ko, Tromp-Taylor scoring, SGF/CSV/JSON export, Wilson 95% CI, Elo difference, and LOS).
2. **Local GTP-WebSocket Bridge (`bridge/gtp_bridge.py`)** runs on each player's computer with Python 3 standard library only (zero `pip` dependencies). It wraps any `stdin`/`stdout` GTP v2 engine on `ws://127.0.0.1:8765`.
3. **WebRTC Rooms (`web/js/net.js`)** connect two browsers peer-to-peer via PeerJS so your model and your friend's model stay on your own machines and GPUs.

## Quick start

### 1. Run a local test (two engines on one computer)

Start two bridge instances (using the bundled `engines/random_gtp.py`, KataGo, or your own model):

```bash
python bridge/gtp_bridge.py --port 8765 -- python engines/random_gtp.py
python bridge/gtp_bridge.py --port 8766 -- python engines/random_gtp.py
```

Serve `web/` over HTTP (ES modules require HTTP/HTTPS rather than `file://`):

```bash
python -m http.server 8000 --directory web
```

Open `http://127.0.0.1:8000`, connect Bridge A (`ws://127.0.0.1:8765`), switch **Seat B** to `Second engine on this computer`, connect Bridge B (`ws://127.0.0.1:8766`), and click **Start match**.

### 2. Remote match via GitHub Pages

1. Push this repository to GitHub and enable **Settings → Pages → Build and deployment → Source: GitHub Actions** (the included `.github/workflows/pages.yml` deploys `web/` automatically).
2. You start your local bridge:
   ```bash
   python bridge/gtp_bridge.py -- python path/to/your_gtp_bot.py
   ```
   Or with `go-ai`:
   ```cmd
   python bridge\gtp_bridge.py -- "D:\AI\projects\go-ai\go-ai.cmd" 2 noponder
   ```
3. Open your GitHub Pages URL, connect your local bridge, set **Seat B** to `Room guest`, click **Create room**, and send the invite link to your friend.
4. Your friend starts `bridge/gtp_bridge.py` with their own model on their computer, opens the invite link, connects their local bridge, and clicks **Join**.

> Note: `gtp_bridge.py` accepts connections from `localhost`, `127.0.0.1`, and `https://*.github.io` by default. If you host the page on a custom domain, pass `--allow-origin https://your.domain`.

## Wrapping an offline AI model in GTP

Any program that reads lines from `stdin` and writes GTP responses (`= <text>\n\n` or `? <error>\n\n`, flushing `stdout`) works with `gtp_bridge.py`. Minimal required commands:

- `protocol_version` → `2`
- `name`, `version`, `list_commands`, `known_command`, `quit`
- `boardsize <N>`, `clear_board`, `komi <K>`
- `play <B|W> <vertex|pass>`
- `genmove <B|W>` → `<vertex|pass|resign>`
- Optional: `final_score` → e.g. `B+2.5` (otherwise the browser referee uses Tromp-Taylor area counting, or you can connect a third referee engine such as KataGo)

See `engines/random_gtp.py` for a complete dependency-free Python template.

## Running tests

```bash
node --test tests/test_web.mjs
python -m unittest discover -s tests -v
```
