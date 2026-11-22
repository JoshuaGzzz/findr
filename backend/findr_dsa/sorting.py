"""Sorting. Binary and jump search only work on sorted data, so FINDr keeps its item lists sorted
with merge sort (divide and conquer, stable, O(n log n) in every case)."""
from __future__ import annotations

from typing import Callable, List, Sequence


def merge_sort(arr: Sequence, key: Callable = lambda x: x, reverse: bool = False) -> List:
    """Stable merge sort. Returns a new list; the input is not modified."""
    items = list(arr)
    if len(items) <= 1:
        return items
    mid = len(items) // 2
    left = merge_sort(items[:mid], key, reverse)
    right = merge_sort(items[mid:], key, reverse)
    return _merge(left, right, key, reverse)


def _merge(left: List, right: List, key: Callable, reverse: bool) -> List:
    out: List = []
    i = j = 0
    while i < len(left) and j < len(right):
        a, b = key(left[i]), key(right[j])
        take_left = a >= b if reverse else a <= b  # <= / >= keeps equal keys in original order
        if take_left:
            out.append(left[i]); i += 1
        else:
            out.append(right[j]); j += 1
    out.extend(left[i:])
    out.extend(right[j:])
    return out


def insertion_sort(arr: Sequence, key: Callable = lambda x: x) -> List:
    """O(n^2) worst case, O(n) when already sorted. Used by the lab as the simple baseline."""
    items = list(arr)
    for i in range(1, len(items)):
        cur = items[i]
        j = i - 1
        while j >= 0 and key(items[j]) > key(cur):
            items[j + 1] = items[j]
            j -= 1
        items[j + 1] = cur
    return items


def is_sorted(arr: Sequence, key: Callable = lambda x: x) -> bool:
    return all(key(arr[i]) <= key(arr[i + 1]) for i in range(len(arr) - 1))
