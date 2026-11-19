"""Searching algorithms: the central DSA component of FINDr.

Every function counts its key comparisons and (optionally) records the steps it took, so the
DSA Lab can show *why* one algorithm beats another instead of only reporting a time.

Complexity summary (n = number of items):
    linear_search          best O(1)    average O(n)       worst O(n)      works on unsorted data
    binary_search          best O(1)    average O(log n)   worst O(log n)  needs sorted data
    jump_search            best O(1)    average O(sqrt n)  worst O(sqrt n) needs sorted data
    lower_bound/upper_bound               O(log n)                        needs sorted data
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, Sequence

MAX_TRACE = 64  # the lab never needs more steps than this to tell the story


def _identity(x):
    return x


@dataclass
class SearchResult:
    """Outcome of one search: where it was found, how much work it took, and the steps taken."""

    index: int = -1
    comparisons: int = 0
    steps: List[dict] = field(default_factory=list)
    algorithm: str = ""

    @property
    def found(self) -> bool:
        return self.index >= 0

    def to_dict(self) -> dict:
        return {
            "algorithm": self.algorithm,
            "found": self.found,
            "index": self.index,
            "comparisons": self.comparisons,
            "steps": self.steps,
        }


def _step(res: SearchResult, trace: bool, **info) -> None:
    if trace and len(res.steps) < MAX_TRACE:
        res.steps.append(info)


# --------------------------------------------------------------------------- linear search
def linear_search(arr: Sequence, target: Any, key: Callable = _identity, trace: bool = False) -> SearchResult:
    """Check every element from the front until the target is found. Works on unsorted data."""
    res = SearchResult(algorithm="linear")
    for i in range(len(arr)):
        res.comparisons += 1
        _step(res, trace, index=i, value=key(arr[i]))
        if key(arr[i]) == target:
            res.index = i
            return res
    return res


# --------------------------------------------------------------------------- binary search
def binary_search(arr: Sequence, target: Any, key: Callable = _identity, trace: bool = False) -> SearchResult:
    """Halve the search window each step. `arr` must be sorted ascending by `key`."""
    res = SearchResult(algorithm="binary")
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        value = key(arr[mid])
        res.comparisons += 1
        _step(res, trace, lo=lo, hi=hi, mid=mid, value=value)
        if value == target:
            res.index = mid
            return res
        if value < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return res


def binary_search_recursive(arr: Sequence, target: Any, key: Callable = _identity) -> SearchResult:
    """Divide-and-conquer version of binary search (same answer, O(log n) call stack)."""
    res = SearchResult(algorithm="binary-recursive")

    def go(lo: int, hi: int) -> int:
        if lo > hi:
            return -1
        mid = (lo + hi) // 2
        res.comparisons += 1
        value = key(arr[mid])
        if value == target:
            return mid
        return go(mid + 1, hi) if value < target else go(lo, mid - 1)

    res.index = go(0, len(arr) - 1)
    return res


# --------------------------------------------------------------------------- jump search
def jump_search(arr: Sequence, target: Any, key: Callable = _identity, trace: bool = False) -> SearchResult:
    """Jump ahead sqrt(n) at a time, then scan the one block that can hold the target. Sorted input."""
    res = SearchResult(algorithm="jump")
    n = len(arr)
    if n == 0:
        return res
    step = max(1, int(math.isqrt(n)))
    prev, cur = 0, step
    while True:
        probe = min(cur, n) - 1
        res.comparisons += 1
        _step(res, trace, jump_to=probe, value=key(arr[probe]))
        if key(arr[probe]) >= target:
            break
        prev, cur = cur, cur + step
        if prev >= n:
            return res
    for i in range(prev, min(cur, n)):
        res.comparisons += 1
        _step(res, trace, index=i, value=key(arr[i]))
        if key(arr[i]) == target:
            res.index = i
            return res
        if key(arr[i]) > target:
            break
    return res


# --------------------------------------------------------------------------- range search
def lower_bound(arr: Sequence, target: Any, key: Callable = _identity) -> SearchResult:
    """Index of the first element >= target (len(arr) if none). Binary search variant, O(log n)."""
    res = SearchResult(algorithm="lower-bound")
    lo, hi = 0, len(arr)
    while lo < hi:
        mid = (lo + hi) // 2
        res.comparisons += 1
        if key(arr[mid]) < target:
            lo = mid + 1
        else:
            hi = mid
    res.index = lo
    return res


def upper_bound(arr: Sequence, target: Any, key: Callable = _identity) -> SearchResult:
    """Index of the first element > target (len(arr) if none). O(log n)."""
    res = SearchResult(algorithm="upper-bound")
    lo, hi = 0, len(arr)
    while lo < hi:
        mid = (lo + hi) // 2
        res.comparisons += 1
        if key(arr[mid]) <= target:
            lo = mid + 1
        else:
            hi = mid
    res.index = lo
    return res


def range_search_binary(arr: Sequence, low: Any, high: Any, key: Callable = _identity):
    """All elements with low <= key <= high from a sorted list. O(log n + k) for k results."""
    a = lower_bound(arr, low, key)
    b = upper_bound(arr, high, key)
    return list(arr[a.index:b.index]), a.comparisons + b.comparisons


def range_search_linear(arr: Sequence, low: Any, high: Any, key: Callable = _identity):
    """Same answer by scanning every element. O(n), but works on unsorted data."""
    out, comparisons = [], 0
    for x in arr:
        comparisons += 1
        if low <= key(x) <= high:
            out.append(x)
    return out, comparisons


# --------------------------------------------------------------------------- registry
ALGORITHMS = {
    "linear": linear_search,
    "binary": binary_search,
    "jump": jump_search,
}


def run(algorithm: str, arr: Sequence, target: Any, key: Callable = _identity, trace: bool = False) -> SearchResult:
    """Run a named algorithm; raises ValueError for unknown names so bad input is never silent."""
    try:
        fn = ALGORITHMS[algorithm]
    except KeyError:
        raise ValueError(f"Unknown search algorithm {algorithm!r}. Choose from {sorted(ALGORITHMS)}.") from None
    return fn(arr, target, key, trace)
