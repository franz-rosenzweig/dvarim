#!/usr/bin/env python3
"""Build the public taste of Dvarim: the real web app on a made-up vault in the
visitor's browser, and a page around it with pictures and links.

    python3 tools/build_taste.py OUT_DIR

OUT_DIR (for stuffs, its site/dvarim/ folder) gets

    index.html, taste.css, taste.js   the page (demo/)
    app/                              the web app, built by Vite from demo/app/,
                                      whose demo.js fills the browser's vault
                                      with demo/vault.js and then loads
                                      frontend/src/main.js as it is
    icons/                            the app's icon (frontend/public/icons)
    shots/                            pictures from docs/images, as WebP, each
                                      name with a hash of its picture in it

Everything runs in the node:22 image, as frontend/build.sh does, so the host
needs only Docker, Python and Pillow. Before building it opens the made-up
vault with the engine (demo/check_vault.mjs) and stops if it doesn't read as
it should. OUT_DIR must be empty or a taste built before (it holds the
.dvarim-taste stamp); it's then replaced as a whole. Nothing in the result
asks a server for anything: there's no service worker, no sync and no
sign-in, and demo/app/demo.js refuses any request outside the folder.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
STAMP = ".dvarim-taste"

# docs/images → shots/, as (picture, name on the page, crop box or None)
SHOTS = [
    ("phones.png", "phones", None),
    ("files.png", "files", None),
    ("upcoming.png", "upcoming", None),
    ("when.png", "when", None),
    ("hero-dark.png", "hero-dark", None),
    # Today on a phone, for the card that opens the app on a phone: the first
    # of the three phones, and the dark one the docs have on its own
    ("phones.png", "today-phone-light", (0, 0, 594, 1156)),
    ("today-phone-dark.png", "today-phone-dark", None),
]
ICONS = ["icon.svg", "favicon-32.png", "apple-touch-icon.png"]
UID = f"{os.getuid()}:{os.getgid()}"

VITE = """
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
await build({
  configFile: false,
  root: '/repo/demo/app',
  base: './',
  publicDir: false,
  logLevel: 'warn',
  plugins: [svelte({ configFile: '/repo/frontend/svelte.config.js' })],
  resolve: { alias: { '@engine': '/repo/engine/src' } },
  build: { outDir: '/out/app', emptyOutDir: true, target: 'es2020', reportCompressedSize: false },
});
"""


def node(args, image="node:22", out=None, workdir="/repo"):
    cmd = ["docker", "run", "--rm", "-u", UID, "-e", "HOME=/tmp", "-v", f"{ROOT}:/repo", "-w", workdir]
    if out:
        # The build's root is demo/app, and vite-plugin-svelte has Vite look
        # for svelte from the root (resolve.dedupe), so frontend's packages are
        # also put where a search upwards from there ends: /node_modules.
        cmd += ["-v", f"{out}:/out", "-v", f"{ROOT / 'frontend' / 'node_modules'}:/node_modules:ro"]
    subprocess.run(cmd + [image] + args, check=True)


def install():
    """npm ci in frontend/ when nothing is installed or the lockfile changed (as build.sh does)."""
    stamp = ROOT / "frontend" / "node_modules" / ".dvarim-lock"
    lock = hashlib.sha1((ROOT / "frontend" / "package-lock.json").read_bytes()).hexdigest()
    if stamp.exists() and stamp.read_text().strip() == lock:
        return
    node(["npm", "ci", "--no-audit", "--no-fund"], workdir="/repo/frontend")
    stamp.write_text(lock + "\n")


def icons_js():
    """name → <svg …> from the app's own icon set."""
    text = (ROOT / "frontend" / "src" / "lib" / "icons.js").read_text(encoding="utf-8")
    return dict(re.findall(r"^\s*(\w+):'(<svg.*?</svg>)'", text, flags=re.M))


def shots(out):
    """Pictures as WebP, named for what's in them, so a new one never meets an old cache."""
    (out / "shots").mkdir()
    names = {}
    for src, name, box in SHOTS:
        im = Image.open(ROOT / "docs" / "images" / src).convert("RGBA")
        if box:
            im = im.crop(box)
        if name.startswith("today-phone"):
            im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
        tmp = out / "shots" / f"{name}.webp"
        im.save(tmp, "WEBP", quality=84, method=6)
        digest = hashlib.sha1(tmp.read_bytes()).hexdigest()[:8]
        final = tmp.with_name(f"{name}-{digest}.webp")
        tmp.rename(final)
        names[f"shots/{name}.webp"] = f"shots/{final.name}"
    return names


def page(out, names):
    html = (ROOT / "demo" / "index.html").read_text(encoding="utf-8")
    svgs = icons_js()

    def icon(m):
        if m.group(1) not in svgs:
            sys.exit(f"demo/index.html wants icon {m.group(1)!r}, which lib/icons.js doesn't have")
        return svgs[m.group(1)]

    html = re.sub(r"<!--icon:(\w+)-->", icon, html)
    for old, new in names.items():
        if old not in html:
            sys.exit(f"demo/index.html doesn't use {old}")
        html = html.replace(old, new)
    (out / "index.html").write_text(html, encoding="utf-8")
    for f in ("taste.css", "taste.js"):
        shutil.copy2(ROOT / "demo" / f, out / f)
    (out / "icons").mkdir()
    for f in ICONS:
        shutil.copy2(ROOT / "frontend" / "public" / "icons" / f, out / "icons" / f)


def check(out):
    """No page or stylesheet that points outside the folder by an absolute path.
    (The app's own scripts name /api/… routes; the page answers those itself,
    and demo/app/demo.js refuses anything else while it runs.)"""
    bad = []
    for p in out.rglob("*"):
        if p.suffix not in (".html", ".css"):
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"""(?:(?:src|href)\s*=\s*["']|url\(\s*["']?)(/[^/"')][^"')]*)""", text):
            bad.append(f"{p.relative_to(out)}: {m.group(1)}")
    if bad:
        sys.exit("absolute paths in the build:\n  " + "\n  ".join(bad[:20]))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dest = Path(sys.argv[1]).resolve()
    if dest.exists() and any(dest.iterdir()) and not (dest / STAMP).exists():
        sys.exit(f"{dest} has other things in it and no {STAMP} stamp; give an empty folder")

    node(["node", "demo/check_vault.mjs"], image="node:22-alpine")
    install()
    with tempfile.TemporaryDirectory(prefix="dvarim-taste-") as tmp:
        out = Path(tmp)
        node(["node", "--input-type=module", "-e", VITE], out=str(out), workdir="/repo/frontend")
        page(out, shots(out))
        check(out)
        (out / STAMP).write_text("Built by tools/build_taste.py in the Dvarim repository; replaced as a whole.\n")
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(out, dest)
    for p in [dest, *dest.rglob("*")]:
        p.chmod(0o755 if p.is_dir() else 0o644)
    size = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file())
    print(f"taste written to {dest} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
