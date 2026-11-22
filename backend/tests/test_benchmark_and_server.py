"""Benchmark sanity and HTTP API tests (the server runs on a free port inside the test)."""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import server
from findr_dsa import benchmark


def test_benchmark_shape_and_ordering():
    r = benchmark.run_benchmark([200, 2000, 20000], queries=30)
    assert r["sizes"] == [200, 2000, 20000] and len(r["rows"]) == 9
    worst = {row["n"]: row for row in r["rows"] if row["case"] == "worst"}
    for n, row in worst.items():
        assert row["linear"]["comparisons"] == n          # absent target: full scan
        assert row["binary"]["comparisons"] < 20           # logarithmic
        assert row["binary"]["comparisons"] < row["jump"]["comparisons"] < row["linear"]["comparisons"]
    best = [row for row in r["rows"] if row["case"] == "best"]
    assert all(row["linear"]["comparisons"] == 1 for row in best)  # linear's one win
    assert "| n |" in benchmark.markdown_table(r)


@pytest.mark.parametrize("sizes", [[], [0], [-5], [benchmark.MAX_SIZE + 1], list(range(1, 9))])
def test_benchmark_rejects_bad_sizes(sizes):
    with pytest.raises(ValueError):
        benchmark.run_benchmark(sizes)


@pytest.fixture(scope="module")
def base():
    server.Handler.index = server.Index(server.build_source(demo=True))
    server.Handler.index.refresh(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def get(base, path):
    try:
        with urllib.request.urlopen(base + path) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def test_health_and_search(base):
    code, h = get(base, "/api/health")
    assert code == 200 and h["ok"] and h["indexed"] == 12
    code, r = get(base, "/api/search?q=black")
    assert code == 200 and r["total"] == 5 and r["metrics"]["engine"] == "python"
    code, r = get(base, "/api/search?q=umbrela")
    assert r["did_you_mean"] == "umbrella"
    assert get(base, "/api/suggest?q=bl")[1]["suggestions"][0] == "blue"


def test_window_algorithms_agree_over_http(base):
    a = get(base, "/api/search?from=0&algo=binary")[1]["ids"]
    b = get(base, "/api/search?from=0&algo=linear")[1]["ids"]
    assert a == b and len(a) == 12


def test_item_lookup_with_trace(base):
    code, r = get(base, "/api/item/4?algo=binary&trace=1")
    assert code == 200 and r["found"] and r["item"]["title"] == "Black wallet" and r["steps"]
    assert "secret" not in r["item"] and "finder_id" not in r["item"]
    assert get(base, "/api/item/999")[1]["found"] is False


@pytest.mark.parametrize("path", [
    "/api/search?from=abc", "/api/search?algo=quantum", "/api/search?sort=random", "/api/search?from=10&to=5",
    "/api/item/notanumber", "/api/lab/trace?n=0&target=1", "/api/lab/trace?n=999&target=1", "/api/lab/trace?n=10",
    "/api/lab/benchmark?sizes=999999999",
])
def test_bad_requests_get_400_not_500(base, path):
    code, body = get(base, path)
    assert code == 400 and "error" in body


def test_unknown_routes_and_paths(base):
    assert get(base, "/api/nope")[0] == 404
    assert get(base, "/../../etc/passwd")[0] == 404   # only the app page is served as a file


def test_lab_endpoints(base):
    code, t = get(base, "/api/lab/trace?n=16&target=22")
    assert code == 200 and t["results"]["binary"]["comparisons"] < t["results"]["linear"]["comparisons"]
    assert len(get(base, "/api/lab/structures")[1]) >= 8
    code, b = get(base, "/api/lab/benchmark?sizes=100,1000,10000")
    assert code == 200 and len(b["rows"]) == 9


def test_supabase_secret_key_is_refused(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "sb_secret_abc")
    with pytest.raises(SystemExit):
        server.build_source(demo=False)
