"""SearchEngine: ties the data structures and searching algorithms together for the FINDr API.

Which DSA does which job:
    merge sort            keeps `by_time` and `by_id` sorted (binary search needs sorted data)
    binary / linear /     find one item by id, and find every item inside a time window
    jump search
    Trie                  keyword and prefix matching, autocomplete
    Levenshtein DP        "did you mean" for typos
    merge sort (again)    final ordering of results (relevance / newest / oldest)

Only items that are publicly searchable (status unclaimed or claim_pending) are ever indexed.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List, Optional

from . import searching
from .sorting import merge_sort
from .structures import Trie
from .text import clean_tokens, tokenize, word_similarity

SEARCHABLE = {"unclaimed", "claim_pending"}
EXACT_ALGOS = ("linear", "binary", "jump")
RANGE_ALGOS = ("linear", "binary")
DEFAULT_ALGO = "binary"
FIX_THRESHOLD = 0.75  # minimum similarity before we offer a spelling correction


def public_view(item: dict) -> dict:
    """The only fields the API ever returns: nothing private (no secret, finder, or drop-off code)."""
    return {
        "id": item["id"],
        "title": item["title"],
        "category": item["category"],
        "gate": item["gate"],
        "tags": list(item.get("tags") or []),
        "description": item.get("description", ""),
        "found_at": item["found_at"],
        "status": item["status"],
    }


class SearchEngine:
    def __init__(self) -> None:
        self.items: Dict[Any, dict] = {}
        self.by_time: List[dict] = []   # sorted by found_at
        self.by_id: List[dict] = []     # sorted by id
        self.trie = Trie()
        self.vocab: Dict[str, int] = {}
        self.loaded_at: Optional[float] = None

    # ------------------------------------------------------------------ loading
    def load(self, items: Iterable[dict]) -> int:
        """Replace the index with `items`. Non-searchable rows are skipped. Returns how many were indexed."""
        self.items, self.trie, self.vocab = {}, Trie(), {}
        for it in items:
            if it.get("status") not in SEARCHABLE:
                continue
            self._validate(it)
            self.items[it["id"]] = it
            for w in self._words(it):
                self.trie.insert(w, it["id"])
                self.vocab[w] = self.vocab.get(w, 0) + 1
        rows = list(self.items.values())
        self.by_time = merge_sort(rows, key=lambda x: x["found_at"])
        self.by_id = merge_sort(rows, key=lambda x: x["id"])
        self.loaded_at = time.time()
        return len(rows)

    @staticmethod
    def _validate(it: dict) -> None:
        for k in ("id", "title", "category", "gate", "found_at", "status"):
            if k not in it or it[k] is None:
                raise ValueError(f"item is missing required field {k!r}: {it!r}")
        if not isinstance(it["found_at"], (int, float)):
            raise ValueError("found_at must be a number (milliseconds since epoch)")

    @staticmethod
    def _words(it: dict) -> List[str]:
        return list(dict.fromkeys(clean_tokens(" ".join([it["title"], " ".join(it.get("tags") or []), it.get("description", "")]))))

    def __len__(self) -> int:
        return len(self.items)

    # ------------------------------------------------------------------ search by id
    def find_by_id(self, item_id: int, algorithm: str = DEFAULT_ALGO, trace: bool = False) -> dict:
        if algorithm not in EXACT_ALGOS:
            raise ValueError(f"algorithm must be one of {EXACT_ALGOS}")
        start = time.perf_counter()
        res = searching.run(algorithm, self.by_id, item_id, key=lambda x: x["id"], trace=trace)
        out = res.to_dict()
        out["ms"] = (time.perf_counter() - start) * 1000
        out["item"] = public_view(self.by_id[res.index]) if res.found else None
        out["n"] = len(self.by_id)
        return out

    # ------------------------------------------------------------------ search by time window
    def find_in_window(self, low: Optional[float], high: Optional[float], algorithm: str = DEFAULT_ALGO) -> dict:
        if algorithm not in RANGE_ALGOS:
            raise ValueError(f"algorithm must be one of {RANGE_ALGOS}")
        lo = float("-inf") if low is None else low
        hi = float("inf") if high is None else high
        if lo > hi:
            raise ValueError("start of the time window is after its end")
        fn = searching.range_search_binary if algorithm == "binary" else searching.range_search_linear
        start = time.perf_counter()
        rows, comparisons = fn(self.by_time, lo, hi, key=lambda x: x["found_at"])
        return {"algorithm": algorithm, "items": rows, "comparisons": comparisons,
                "ms": (time.perf_counter() - start) * 1000, "n": len(self.by_time)}

    # ------------------------------------------------------------------ autocomplete
    def suggest(self, text: str, limit: int = 6) -> List[str]:
        toks = tokenize(text)
        if not toks:
            return []
        last, head = toks.pop(), " ".join(toks)
        return [(head + " " if head else "") + w for w in self.trie.suggest(last, limit)]

    # ------------------------------------------------------------------ full search
    def search(self, q: str = "", category: str = "", gate: str = "", low: Optional[float] = None,
               high: Optional[float] = None, sort: str = "relevance", algorithm: str = DEFAULT_ALGO) -> dict:
        if sort not in ("relevance", "newest", "oldest"):
            raise ValueError("sort must be relevance, newest or oldest")
        if algorithm not in RANGE_ALGOS:
            raise ValueError(f"algorithm must be one of {RANGE_ALGOS}")
        started = time.perf_counter()
        toks = clean_tokens(q)
        did_you_mean = None
        scores: Dict[Any, int] = {}

        if not toks:
            scores = {it["id"]: 0 for it in self.by_time}
        else:
            fixed, corrected = [], False
            for t in toks:
                if self.trie.has_prefix(t):
                    fixed.append(t)
                    continue
                best, best_sim = None, 0.0
                for w in self.vocab:
                    s = word_similarity(t, w)
                    if s > best_sim:
                        best, best_sim = w, s
                if best and best_sim >= FIX_THRESHOLD:
                    fixed.append(best)
                    corrected = True
                else:
                    fixed.append(t)
            if corrected:
                did_you_mean = " ".join(fixed)
            sets = [self.trie.search_prefix(t) for t in fixed]
            smallest_first = sorted(range(len(sets)), key=lambda i: len(sets[i]))
            inter = set(sets[smallest_first[0]])
            for i in smallest_first[1:]:
                inter &= sets[i]
            pool = inter if inter else set().union(*sets)  # fall back to "any word matches"
            for item_id in pool:
                title_toks = clean_tokens(self.items[item_id]["title"])
                scores[item_id] = sum(
                    (3 if any(w.startswith(fixed[i]) for w in title_toks) else 1)
                    for i in range(len(fixed)) if item_id in sets[i]
                )

        # time window: binary search on the sorted array (or linear scan, when asked to compare)
        window = {"algorithm": algorithm, "comparisons": 0}
        if low is not None or high is not None:
            w = self.find_in_window(low, high, algorithm)
            window["comparisons"] = w["comparisons"]
            keep = {it["id"] for it in w["items"]}
            scores = {i: s for i, s in scores.items() if i in keep}

        rows = [self.items[i] for i in scores
                if (not category or self.items[i]["category"] == category) and (not gate or self.items[i]["gate"] == gate)]
        if sort == "oldest":
            rows = merge_sort(rows, key=lambda x: x["found_at"])
        elif sort == "newest":
            rows = merge_sort(rows, key=lambda x: x["found_at"], reverse=True)
        else:  # best score first, newest first among equals
            rows = merge_sort(rows, key=lambda x: (scores[x["id"]], x["found_at"]), reverse=True)

        return {
            "total": len(rows),
            "ids": [r["id"] for r in rows],
            "scores": {str(r["id"]): scores[r["id"]] for r in rows},
            "did_you_mean": did_you_mean,
            "metrics": {
                "engine": "python",
                "algorithm": algorithm,
                "indexed": len(self.items),
                "window_comparisons": window["comparisons"],
                "ms": round((time.perf_counter() - started) * 1000, 3),
            },
        }

    def snapshot(self) -> dict:
        return {"indexed": len(self.items), "trie_words": self.trie.word_count, "loaded_at": self.loaded_at}
