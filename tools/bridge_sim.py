#!/usr/bin/env python3
"""The native side of docs/BRIDGE.md, over a real folder, in a few dozen lines.

Two uses. tools/e2e_folder.py runs the app in a browser as if it were inside
the Mac or Android shell: a script it puts in the page carries each bridge
message here over HTTP, and this answers it from the folder. And it is the
reference for the shells' own implementations (mac/next/, android/next/):
when they and this disagree about a message, the protocol document decides,
and then this is fixed to match.

    tools/bridge_sim.py --root /tmp/dv-folder --host 172.19.0.1 --port 8431

POST /call     a bridge message → its reply, one at a time, in arrival order
GET  /log      the ops asked for so far, for tests ("pick", "useServer"…)
POST /fail     {"op": "write", "code": "EACCES"} makes that op fail until
               POST /fail {} — how a test sees a save that did not happen

Two optional ops a shell may offer, each said in `info`:
  --calendars FILE   the device's calendars, from a JSON file read at each ask
                     {"calendars": [{name, color}], "events": [{uid, title, calendar,
                     color, allDay, start, end}]}: ops `calendars` and `events`
  --http             op `http`: requests made here, as a shell makes them
It always takes `changed` (the page's word that the vault changed), and logs it.
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PROTOCOL = 1
IGNORED_DIRS = {".obsidian", ".trash", ".git", ".stfolder", ".stversions", "node_modules"}   # .dvarim is listed


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class Folder:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def abs(self, path) -> Path:
        """A vault path, or EINVAL: relative, '/'-separated, no ''/'.'/'..'
        segment, and still inside the root once symlinks are followed."""
        if not isinstance(path, str) or not path or path.startswith("/") or "\\" in path or "\0" in path \
                or any(seg in ("", ".", "..") for seg in path.split("/")):
            raise BridgeError("EINVAL", f"not a path inside the vault: {path!r}")
        p = self.root.joinpath(*path.split("/"))
        real = p.resolve()
        if real != self.root and self.root not in real.parents:
            raise BridgeError("EINVAL", f"outside the vault: {path!r}")
        return p

    def rel(self, p: Path) -> str:
        return p.relative_to(self.root).as_posix()

    def list(self):
        files, dirs = [], []
        for dirpath, dirnames, filenames in os.walk(self.root):
            here = Path(dirpath)
            for d in list(dirnames):
                dirs.append(self.rel(here / d))
                if d in IGNORED_DIRS:
                    dirnames.remove(d)            # listed, but not looked inside
            for f in filenames:
                if not f.endswith(".dvarim-tmp"):
                    files.append(self.rel(here / f))
        return {"files": files, "dirs": dirs}

    def read(self, path):
        p = self.abs(path)
        if not p.is_file():
            return None
        data = p.read_bytes()                     # bytes: no newline translation
        return {"text": data.decode("utf-8", "replace"), "mtime": p.stat().st_mtime_ns / 1e6}

    def write(self, path, text):
        if not isinstance(text, str):
            raise BridgeError("EINVAL", "text must be a string")
        p = self.abs(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name("." + p.name + ".dvarim-tmp")
        tmp.write_bytes(text.encode("utf-8"))    # exactly these bytes: no BOM, no \r\n
        os.replace(tmp, p)                        # atomic: a reader never sees half
        return {"mtime": p.stat().st_mtime_ns / 1e6}

    def remove(self, path):
        p = self.abs(path)
        if p.is_file() or p.is_symlink():
            p.unlink()

    def move(self, src, dst):
        a, b = self.abs(src), self.abs(dst)
        if not (a.exists() or a.is_symlink()):
            raise BridgeError("ENOENT", f"not there: {src}")
        if b.exists() or b.is_symlink():
            # a folder may replace an empty folder, as rename(2) does; nothing else is replaced
            if not (a.is_dir() and b.is_dir() and not any(b.iterdir())):
                raise BridgeError("EEXIST", f"already there: {dst}")
        b.parent.mkdir(parents=True, exist_ok=True)
        os.rename(a, b)

    def mkdir(self, path):
        self.abs(path).mkdir(parents=True, exist_ok=True)

    def remove_dir(self, path):
        p = self.abs(path)
        if not p.exists():
            return True
        if any(p.iterdir()):
            return False
        p.rmdir()
        return True


def overlaps(ev: dict, frm: str, to: str) -> bool:
    """An occurrence touching the days frm..to (both included)."""
    start = ev["start"][:10]
    end = (ev.get("end") or ev["start"])[:10]
    return start <= to and end >= frm


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def http_request(a: dict) -> dict:
    """One request, as a shell makes it: no cookies, no redirects, 30 s."""
    body = a.get("body")
    req = urllib.request.Request(a["url"], data=None if body is None else body.encode(), method=a.get("method", "GET"),
                                 headers=a.get("headers") or {})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=30) as r:
            return {"status": r.status, "headers": dict(r.headers.items()), "body": r.read().decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "headers": dict(e.headers.items()), "body": e.read().decode("utf-8", "replace")}
    except (urllib.error.URLError, OSError) as e:
        raise BridgeError("EIO", f"could not reach {a.get('url')}: {e}")


def answer(folder: Folder, msg: dict, failing: dict, extras: dict = None) -> dict:
    extras = extras or {}
    if msg.get("v") != PROTOCOL:
        return {"error": {"code": "EPROTO", "message": f"this shell speaks protocol {PROTOCOL}, not {msg.get('v')}"}}
    op, a = msg.get("op"), msg.get("args") or {}
    if failing.get("op") == op:
        return {"error": {"code": failing.get("code", "EIO"), "message": failing.get("message", "the folder refused")}}
    try:
        if op == "list":
            return {"ok": folder.list()}
        if op == "read":
            return {"ok": folder.read(a.get("path"))}
        if op == "readMany":
            return {"ok": [folder.read(p) for p in a.get("paths", [])]}
        if op == "write":
            return {"ok": folder.write(a.get("path"), a.get("text"))}
        if op == "remove":
            folder.remove(a.get("path")); return {"ok": None}
        if op == "move":
            folder.move(a.get("from"), a.get("to")); return {"ok": None}
        if op == "mkdir":
            folder.mkdir(a.get("path")); return {"ok": None}
        if op == "removeDir":
            return {"ok": folder.remove_dir(a.get("path"))}
        if op == "info":
            return {"ok": {"name": folder.root.name, "detail": str(folder.root), "canPick": True,
                           "canUseServer": True, "pollSeconds": 0,
                           "calendars": extras.get("calendars") is not None, "http": bool(extras.get("http")),
                           "changes": True}}
        if op == "changed":
            return {"ok": None}                   # a real shell refreshes its menu bar, badge, reminders
        if op in ("calendars", "events") and extras.get("calendars") is not None:
            cal = json.loads(Path(extras["calendars"]).read_text()) if Path(extras["calendars"]).exists() else {}
            if op == "calendars":
                return {"ok": cal.get("calendars", [])}
            names = a.get("calendars")
            evs = [e for e in cal.get("events", []) if overlaps(e, a.get("from", ""), a.get("to", ""))
                   and (names is None or e.get("calendar") in names)]
            return {"ok": evs}
        if op == "http" and extras.get("http"):
            return {"ok": http_request(a)}
        if op == "pick":
            return {"ok": {"changed": False}}     # a real shell shows its picker, and reloads if one was chosen
        if op == "useServer":
            return {"ok": None}                   # a real shell reloads from the server
        return {"error": {"code": "ENOSYS", "message": f"no such operation: {op}"}}
    except BridgeError as e:
        return {"error": {"code": e.code, "message": str(e)}}
    except FileNotFoundError as e:
        return {"error": {"code": "ENOENT", "message": str(e)}}
    except PermissionError as e:
        return {"error": {"code": "EACCES", "message": str(e)}}
    except OSError as e:
        return {"error": {"code": "EIO", "message": str(e)}}


def serve(root: Path, host: str, port: int, extras: dict = None):
    folder = Folder(root)
    log, failing = [], {}

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self._send(204, {})

        def do_GET(self):
            if self.path == "/log":
                return self._send(200, log)
            self._send(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/fail":
                failing.clear(); failing.update(body)
                return self._send(200, {"ok": True})
            if self.path == "/call":
                log.append({"op": body.get("op"), "at": time.time()})
                return self._send(200, answer(folder, body, failing, extras))
            self._send(404, {})

        def log_message(self, *a):
            pass

    # one request at a time, in the order they arrive: the protocol's ordering
    HTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8431)
    ap.add_argument("--calendars", help="a JSON file of the device's calendars and events")
    ap.add_argument("--http", action="store_true", help="offer op http")
    args = ap.parse_args()
    extras = {"http": args.http, "calendars": args.calendars}      # the file is read at each ask
    serve(Path(args.root), args.host, args.port, extras)
