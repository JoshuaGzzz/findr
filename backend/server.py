"""FINDr Python server: standard library only (no pip install needed).

    python backend/server.py                 # items from Supabase (set SUPABASE_URL + SUPABASE_KEY)
    python backend/server.py --demo          # built-in sample items, no network or accounts needed

Serves the web app at / and a small JSON API at /api/*. Login and storage stay in Supabase;
this server only reads the publicly searchable items and runs every search with the DSA in findr_dsa/.
The /api/* routes live in findr_api.py, which the Vercel function in api/index.py also uses.
"""
from __future__ import annotations

import argparse
import os
import sys
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from findr_api import ApiHandler, Index, load_demo_items, supabase_source  # noqa: E402,F401


class Handler(ApiHandler):
    def _static(self, path: str) -> None:
        if path not in ("/", "/index.html"):
            return self._json({"error": "not found"}, 404)
        for candidate in (os.path.join(ROOT, "dist", "index.html"), os.path.join(ROOT, "findr.html")):
            if os.path.isfile(candidate):
                with open(candidate, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
        self._json({"error": "web app not built. Run: npm install && npm run build"}, 404)


def build_source(demo: bool):
    if demo:
        return load_demo_items
    try:
        return supabase_source()
    except ValueError as exc:
        raise SystemExit(f"Refusing to start: {exc} Or run with --demo.") from None


def main() -> None:
    ap = argparse.ArgumentParser(description="FINDr Python server")
    ap.add_argument("--demo", action="store_true", help="use built-in sample items instead of Supabase")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 3000)))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    args = ap.parse_args()
    Handler.index = Index(build_source(args.demo))
    Handler.index.refresh(force=True)
    if Handler.index.error:
        print("warning: could not load items:", Handler.index.error)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"FINDr on http://{args.host}:{args.port}  ({len(Handler.index.engine)} items indexed, source: {'demo' if args.demo else 'supabase'})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
