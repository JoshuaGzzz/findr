"""FINDr JSON API shared by the local server (backend/server.py) and the Vercel function (api/index.py).

Standard library only. Reads the publicly searchable items (demo file or Supabase REST with the publishable key)
and answers every /api/* route with the DSA in findr_dsa/.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

from findr_dsa import SearchEngine
from findr_dsa import benchmark
from findr_dsa import searching
from findr_dsa.searching import ALGORITHMS

HERE = os.path.dirname(os.path.abspath(__file__))
REFRESH_SECONDS = 30
MAX_QUERY_LEN = 200


# ---------------------------------------------------------------------------------- data sources
def _to_ms(value) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc).timestamp() * 1000)


def load_demo_items() -> list:
    with open(os.path.join(HERE, "demo_items.json"), encoding="utf-8") as f:
        rows = json.load(f)
    now = int(time.time() * 1000)
    return [{**r, "found_at": now - int(r.pop("age_hours") * 3_600_000)} if "age_hours" in r else r for r in rows]


def load_supabase_items(url: str, key: str) -> list:
    """Read the public item rows with the publishable key. Row-level security already limits an
    anonymous reader to unclaimed / claim_pending items, and we ask for no private columns."""
    cols = "id,title,category,gate,tags,description,found_at,status"
    query = f"{url.rstrip('/')}/rest/v1/items?select={cols}&status=in.(unclaimed,claim_pending)&order=id"
    req = urllib.request.Request(query, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        rows = json.load(resp)
    return [{**r, "found_at": _to_ms(r["found_at"])} for r in rows]


def supabase_source():
    """Loader for SUPABASE_URL + SUPABASE_KEY. Raises ValueError if they are missing or the key is not publishable."""
    url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_KEY", "")
    if not url or not key:
        raise ValueError("Set SUPABASE_URL and SUPABASE_KEY (publishable key).")
    if key.startswith("sb_secret_") or "service_role" in key.lower():
        raise ValueError("SUPABASE_KEY must be the publishable/anon key, never a secret or service_role key.")
    return lambda: load_supabase_items(url, key)


class Index:
    """Holds the engine and reloads it from the data source when it gets old. Thread safe."""

    def __init__(self, source):
        self.source = source
        self.engine = SearchEngine()
        self.lock = threading.Lock()
        self.error = None
        self.last_try = 0.0

    def refresh(self, force: bool = False) -> None:
        with self.lock:
            if not force and time.time() - self.last_try < REFRESH_SECONDS and self.engine.loaded_at:
                return
            self.last_try = time.time()
            try:
                fresh = SearchEngine()
                fresh.load(self.source())
                self.engine, self.error = fresh, None   # swap only after a successful load
            except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
                self.error = f"{type(exc).__name__}: {exc}"  # keep serving the previous index


# ---------------------------------------------------------------------------------- HTTP
class BadRequest(Exception):
    pass


def _num(params, name):
    raw = params.get(name, [""])[0]
    if raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        raise BadRequest(f"{name} must be a number") from None


class ApiHandler(BaseHTTPRequestHandler):
    index: Index = None  # set by server.py main() or api/index.py
    cors = True
    server_version = "FINDr/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if os.environ.get("FINDR_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status: int = 200) -> None:
        self._send(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/refresh":
            self.index.refresh(force=True)
            return self._json({"ok": self.index.error is None, "error": self.index.error, **self.index.engine.snapshot()})
        self._json({"error": "not found"}, 404)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(url.query)
        try:
            if url.path.startswith("/api/"):
                return self._api(url.path, params)
            return self._static(url.path)
        except BadRequest as exc:
            self._json({"error": str(exc)}, 400)
        except ValueError as exc:  # raised by the engine for invalid algorithm / sort / window
            self._json({"error": str(exc)}, 400)

    def _static(self, path: str) -> None:
        self._json({"error": "not found"}, 404)

    # ------------------------------------------------------------------ API routes
    def _api(self, path: str, params: dict) -> None:
        idx = self.index
        idx.refresh()
        if idx.engine.loaded_at is None:  # nothing has loaded on this instance yet: let the page use its JS fallback
            return self._json({"ok": False, "error": f"items could not be loaded: {idx.error}"}, 503)
        if path == "/api/health":
            return self._json({"ok": True, "source_error": idx.error, **idx.engine.snapshot(), "algorithms": sorted(ALGORITHMS)})
        engine = idx.engine
        q = params.get("q", [""])[0][:MAX_QUERY_LEN]
        if path == "/api/search":
            return self._json(engine.search(
                q=q, category=params.get("category", [""])[0], gate=params.get("gate", [""])[0],
                low=_num(params, "from"), high=_num(params, "to"), sort=params.get("sort", ["relevance"])[0],
                algorithm=params.get("algo", ["binary"])[0]))
        if path == "/api/suggest":
            return self._json({"suggestions": engine.suggest(q)})
        if path.startswith("/api/item/"):
            try:
                item_id = int(path.rsplit("/", 1)[1])
            except ValueError:
                raise BadRequest("item id must be a whole number") from None
            return self._json(engine.find_by_id(item_id, params.get("algo", ["binary"])[0], trace=params.get("trace", ["0"])[0] == "1"))
        if path == "/api/lab/benchmark":
            sizes = [int(s) for s in params.get("sizes", [""])[0].split(",") if s.strip().isdigit()] or list(benchmark.DEFAULT_SIZES)
            return self._json(benchmark.run_benchmark(sizes))
        if path == "/api/lab/trace":
            return self._json(self._lab_trace(params))
        if path == "/api/lab/structures":
            return self._json(LAB_STRUCTURES)
        self._json({"error": "not found"}, 404)

    def _lab_trace(self, params: dict) -> dict:
        """Run all three algorithms on the same small sorted array so the lab can show every step."""
        raw_n = _num(params, "n")
        n = 32 if raw_n is None else int(raw_n)  # only a missing value defaults; 0 must be rejected
        if not 1 <= n <= 200:
            raise BadRequest("n must be between 1 and 200")
        target = _num(params, "target")
        if target is None:
            raise BadRequest("target is required")
        arr = [2 * i for i in range(n)]  # sorted, even numbers: odd targets are guaranteed misses
        return {"array": arr, "target": target,
                "results": {name: searching.run(name, arr, target, trace=True).to_dict() for name in ALGORITHMS}}


LAB_STRUCTURES = [
    {"name": "Binary search", "kind": "algorithm", "where": "Find an item by id; find items inside a time window (lower/upper bound).",
     "time": "O(log n)", "space": "O(1)", "needs": "sorted data"},
    {"name": "Linear search", "kind": "algorithm", "where": "Baseline for the comparison; works on unsorted data.",
     "time": "O(n)", "space": "O(1)", "needs": "nothing"},
    {"name": "Jump search", "kind": "algorithm", "where": "Third contender: blocks of sqrt(n) then a short scan.",
     "time": "O(sqrt n)", "space": "O(1)", "needs": "sorted data"},
    {"name": "Merge sort", "kind": "algorithm", "where": "Keeps the item arrays sorted; orders results by relevance or date.",
     "time": "O(n log n)", "space": "O(n)", "needs": "nothing"},
    {"name": "Trie", "kind": "data structure", "where": "Keyword and prefix search, autocomplete while typing.",
     "time": "O(L + matches)", "space": "O(total letters)", "needs": "nothing"},
    {"name": "Queue", "kind": "data structure", "where": "Claims waiting for staff review, first come first served.",
     "time": "O(1) enqueue/dequeue", "space": "O(n)", "needs": "nothing"},
    {"name": "Stack", "kind": "data structure", "where": "Undo of staff actions, last action first.",
     "time": "O(1) push/pop", "space": "O(n)", "needs": "nothing"},
    {"name": "Min-heap", "kind": "data structure", "where": "Retention: which held item is oldest and due for disposal.",
     "time": "O(log n) push/pop", "space": "O(n)", "needs": "nothing"},
    {"name": "Linked list", "kind": "data structure", "where": "Append-only chain-of-custody trail for one item; backs the queue.",
     "time": "O(1) append, O(n) find", "space": "O(n)", "needs": "nothing"},
    {"name": "Edit distance (dynamic programming)", "kind": "algorithm", "where": "'Did you mean' typo correction.",
     "time": "O(a*b)", "space": "O(b)", "needs": "nothing"},
]
