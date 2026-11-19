"""Performance comparison of the searching algorithms (rubric ILO2/ILO3).

Methodology
    * Same sorted dataset and same targets for every algorithm (equivalent inputs).
    * Three or more input sizes, so the growth rate is visible.
    * Best case (target is first), average case (random present targets) and worst case (target absent / last).
    * Two measurements: comparisons (machine independent, exact) and wall time (perf_counter, machine dependent).

Run from the command line:   python -m findr_dsa.benchmark --sizes 1000 10000 100000
"""
from __future__ import annotations

import argparse
import json
import random
import time
from typing import Callable, Dict, List

from . import searching

MAX_SIZE = 200_000      # the HTTP API refuses anything bigger so nobody can stall the server
MAX_SIZES = 6
DEFAULT_SIZES = (1_000, 10_000, 100_000)
ALGOS = ("linear", "binary", "jump")


def _dataset(n: int) -> List[dict]:
    """Items shaped like real ones, sorted by id (ids skip by 2 so odd numbers are guaranteed misses)."""
    return [{"id": 2 * i, "found_at": 1_700_000_000_000 + i * 60_000} for i in range(n)]


def _measure(fn: Callable, arr: List[dict], targets: List[int], repeats: int) -> Dict[str, float]:
    key = lambda r: r["id"]
    comparisons = 0
    for t in targets:
        comparisons += fn(arr, t, key).comparisons
    best = float("inf")
    for _ in range(repeats):
        start = time.perf_counter()
        for t in targets:
            fn(arr, t, key)
        best = min(best, time.perf_counter() - start)
    return {"avg_comparisons": comparisons / len(targets), "avg_us": best / len(targets) * 1e6}


def run_benchmark(sizes=DEFAULT_SIZES, queries: int = 200, seed: int = 2026) -> dict:
    """Compare linear, binary and jump search on each size. Returns a JSON-friendly dict."""
    sizes = [int(s) for s in sizes]
    if not 1 <= len(sizes) <= MAX_SIZES or any(s < 1 or s > MAX_SIZE for s in sizes):
        raise ValueError(f"give 1-{MAX_SIZES} sizes, each between 1 and {MAX_SIZE}")
    rng = random.Random(seed)
    rows = []
    for n in sorted(sizes):
        arr = _dataset(n)
        q = max(10, min(queries, 2_000_000 // n))  # keep the slow algorithm's total work bounded
        cases = {
            "best": [arr[0]["id"]],
            "average": [arr[rng.randrange(n)]["id"] for _ in range(q)],
            "worst": [2 * n - 1] * min(q, 20),  # odd id: absent, forces a full scan / full descent
        }
        for case, targets in cases.items():
            row = {"n": n, "case": case}
            for name in ALGOS:
                m = _measure(searching.ALGORITHMS[name], arr, targets, repeats=3)
                row[name] = {"comparisons": round(m["avg_comparisons"], 1), "us": round(m["avg_us"], 3)}
            rows.append(row)
    return {"sizes": sorted(sizes), "algorithms": list(ALGOS), "rows": rows,
            "note": "comparisons are exact; microseconds depend on the machine"}


def markdown_table(result: dict) -> str:
    head = "| n | case | linear comps | binary comps | jump comps | linear us | binary us | jump us |\n|---|---|---|---|---|---|---|---|\n"
    body = "\n".join(
        f"| {r['n']:,} | {r['case']} | {r['linear']['comparisons']:g} | {r['binary']['comparisons']:g} | {r['jump']['comparisons']:g} "
        f"| {r['linear']['us']:g} | {r['binary']['us']:g} | {r['jump']['us']:g} |" for r in result["rows"])
    return head + body


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Compare linear, binary and jump search.")
    ap.add_argument("--sizes", type=int, nargs="+", default=list(DEFAULT_SIZES))
    ap.add_argument("--queries", type=int, default=200)
    ap.add_argument("--json", action="store_true", help="print JSON instead of a markdown table")
    args = ap.parse_args()
    out = run_benchmark(args.sizes, args.queries)
    print(json.dumps(out, indent=2) if args.json else markdown_table(out))
