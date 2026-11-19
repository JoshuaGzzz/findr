"""Tests: normal, boundary and invalid inputs for every algorithm and data structure."""
import random

import pytest

from findr_dsa import (LinkedList, MinHeap, Queue, SearchEngine, Stack, Trie, binary_search, binary_search_recursive,
                       insertion_sort, is_sorted, jump_search, linear_search, lower_bound, merge_sort,
                       range_search_binary, range_search_linear, upper_bound)
from findr_dsa.searching import run
from findr_dsa.text import levenshtein, word_similarity

SEARCHERS = [linear_search, binary_search, jump_search]


# ------------------------------------------------------------------ searching: normal / boundary / invalid
@pytest.mark.parametrize("fn", SEARCHERS)
def test_finds_every_element_and_misses_absent_ones(fn):
    arr = list(range(0, 200, 2))
    for i, v in enumerate(arr):
        assert fn(arr, v).index == i
    for missing in (-1, 1, 99, 199, 500):
        assert not fn(arr, missing).found


@pytest.mark.parametrize("fn", SEARCHERS)
def test_boundaries_empty_single_first_last(fn):
    assert not fn([], 5).found
    assert fn([5], 5).index == 0
    assert not fn([5], 4).found
    arr = [1, 3, 5, 7, 9, 11]
    assert fn(arr, 1).index == 0
    assert fn(arr, 11).index == 5


@pytest.mark.parametrize("fn", SEARCHERS)
def test_key_function(fn):
    rows = [{"id": i * 3} for i in range(50)]
    assert fn(rows, 21, key=lambda r: r["id"]).index == 7


def test_all_algorithms_agree_on_random_data():
    rng = random.Random(7)
    arr = sorted(rng.sample(range(10_000), 500))
    for _ in range(300):
        t = rng.randrange(10_000)
        answers = {fn(arr, t).index for fn in SEARCHERS} | {binary_search_recursive(arr, t).index}
        assert len(answers) == 1


def test_linear_search_best_and_worst_case_comparisons():
    arr = list(range(1000))
    assert linear_search(arr, 0).comparisons == 1        # best: O(1)
    assert linear_search(arr, 999).comparisons == 1000   # worst: O(n)
    assert linear_search(arr, -5).comparisons == 1000    # miss: O(n)


def test_binary_search_is_logarithmic():
    arr = list(range(1_000_000))
    worst = max(binary_search(arr, t).comparisons for t in (0, 1, 999_999, 123_456, -1, 2_000_000))
    assert worst <= 20  # ceil(log2(1e6)) = 20


def test_jump_search_is_about_sqrt_n():
    arr = list(range(10_000))
    assert max(jump_search(arr, t).comparisons for t in (0, 5_000, 9_999, 10_001)) <= 2 * 100 + 2


def test_trace_records_steps_and_is_capped():
    arr = list(range(100_000))
    res = binary_search(arr, 77_777, trace=True)
    assert 0 < len(res.steps) == res.comparisons
    assert all({"lo", "hi", "mid"} <= set(s) for s in res.steps)
    assert len(linear_search(arr, 99_999, trace=True).steps) <= 64
    assert binary_search(arr, 5).steps == []


def test_unknown_algorithm_is_rejected():
    with pytest.raises(ValueError):
        run("quantum", [1, 2, 3], 2)


# ------------------------------------------------------------------ range search
def test_bounds_and_ranges_match_linear():
    arr = [1, 2, 2, 2, 5, 8, 8, 13]
    assert lower_bound(arr, 2).index == 1
    assert upper_bound(arr, 2).index == 4
    assert lower_bound(arr, 0).index == 0
    assert lower_bound(arr, 99).index == len(arr)
    rng = random.Random(3)
    data = sorted(rng.randrange(1000) for _ in range(400))
    for _ in range(200):
        lo, hi = sorted((rng.randrange(-50, 1050), rng.randrange(-50, 1050)))
        assert range_search_binary(data, lo, hi)[0] == range_search_linear(data, lo, hi)[0]


def test_binary_range_does_far_fewer_comparisons():
    data = list(range(100_000))
    _, b = range_search_binary(data, 40_000, 40_010)
    _, l = range_search_linear(data, 40_000, 40_010)
    assert b < 40 and l == 100_000


# ------------------------------------------------------------------ sorting
def test_merge_sort_correct_stable_and_pure():
    rng = random.Random(1)
    data = [rng.randrange(100) for _ in range(500)]
    original = list(data)
    assert merge_sort(data) == sorted(data) and data == original
    assert merge_sort(data, reverse=True) == sorted(data, reverse=True)
    pairs = [(1, "a"), (0, "b"), (1, "c"), (0, "d")]
    assert merge_sort(pairs, key=lambda p: p[0]) == [(0, "b"), (0, "d"), (1, "a"), (1, "c")]
    assert merge_sort([]) == [] and merge_sort([9]) == [9]
    assert is_sorted(merge_sort(data)) and not is_sorted([2, 1])
    assert insertion_sort(data) == sorted(data)


# ------------------------------------------------------------------ data structures
def test_linked_list():
    ll = LinkedList([1, 2, 3])
    ll.append(4); ll.prepend(0)
    assert ll.to_list() == [0, 1, 2, 3, 4] and len(ll) == 5
    assert ll.find(lambda v: v == 3) == 3 and ll.find(lambda v: v == 9) is None
    assert ll.remove(lambda v: v == 0) and ll.remove(lambda v: v == 4) and not ll.remove(lambda v: v == 9)
    assert ll.to_list() == [1, 2, 3]
    ll.append(5)
    assert ll.to_list()[-1] == 5          # tail pointer survived removing the old tail
    ll.reverse()
    assert ll.to_list() == [5, 3, 2, 1]
    with pytest.raises(IndexError):
        LinkedList().pop_front()


def test_queue_is_fifo():
    q = Queue()
    for c in "abc":
        q.enqueue(c)
    assert q.peek() == "a" and len(q) == 3
    assert [q.dequeue() for _ in range(3)] == ["a", "b", "c"]
    assert q.is_empty()
    with pytest.raises(IndexError):
        q.dequeue()
    q.enqueue("z")  # reusable after draining
    assert q.dequeue() == "z"


def test_stack_is_lifo_with_cap():
    s = Stack(limit=3)
    for i in range(5):
        s.push(i)
    assert len(s) == 3 and s.to_list() == [4, 3, 2]
    assert s.pop() == 4 and s.peek() == 3
    with pytest.raises(IndexError):
        Stack().pop()
    with pytest.raises(ValueError):
        Stack(limit=0)


def test_min_heap_orders_correctly():
    rng = random.Random(5)
    data = [rng.randrange(1000) for _ in range(300)]
    h = MinHeap()
    for v in data:
        h.push(v)
    assert h.smallest(5) == sorted(data)[:5] and len(h) == 300
    assert [h.pop() for _ in range(300)] == sorted(data)
    with pytest.raises(IndexError):
        h.pop()
    byage = MinHeap(key=lambda x: x["found"])
    for f in (5, 1, 3):
        byage.push({"found": f})
    assert byage.peek()["found"] == 1


def test_trie_search_suggest_remove():
    t = Trie()
    t.insert("umbrella", 1); t.insert("umbrella", 2); t.insert("umbrellas", 3); t.insert("bottle", 4)
    assert t.search_prefix("umb") == {1, 2, 3} and t.search_prefix("bot") == {4}
    assert t.search_prefix("zzz") == set() and t.search_prefix("") == set()
    assert t.suggest("umb") == ["umbrella", "umbrellas"]
    assert t.has_prefix("bott") and not t.has_prefix("x") and not t.has_prefix("")
    t.remove("umbrella", 1)
    assert t.search_prefix("umbrella") == {2, 3}
    t.remove("umbrella", 2)
    assert t.suggest("umb") == ["umbrellas"]
    t.remove("umbrellas", 3)
    assert not t.has_prefix("umb") and t.word_count == 1
    t.remove("ghost", 9)  # removing something absent is harmless


def test_levenshtein_and_similarity():
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein("", "abc") == 3 and levenshtein("same", "same") == 0
    assert word_similarity("umbrela", "umbrella") > 0.75 and word_similarity("cat", "dog") < 0.5


# ------------------------------------------------------------------ engine
NOW = 1_700_000_000_000
H = 3_600_000


def make_items():
    rows = [
        (3, "Black umbrella", "umbrellas", "g-lib", ["black", "folding"], 3 * 24),
        (1, "Blue Hydro Flask tumbler", "bottles", "g-gym", ["blue", "steel"], 5 * 24),
        (7, "Black wallet", "wallets", "g-main", ["black", "leather"], 48),
        (5, "Grey backpack", "bags", "g-eng", ["grey"], 12 * 24),
        (9, "AirPods case", "electronics", "g-lib", ["white"], 4 * 24),
    ]
    items = [{"id": i, "title": t, "category": c, "gate": g, "tags": tags, "description": "", "found_at": NOW - ago * H,
              "status": "unclaimed"} for i, t, c, g, tags, ago in rows]
    items.append({"id": 11, "title": "Claimed phone", "category": "electronics", "gate": "g-lib", "tags": [], "description": "",
                  "found_at": NOW, "status": "claimed"})
    return items


@pytest.fixture
def engine():
    e = SearchEngine()
    e.load(make_items())
    return e


def test_engine_indexes_only_searchable_items(engine):
    assert len(engine) == 5 and engine.find_by_id(11)["found"] is False


@pytest.mark.parametrize("algo", ["linear", "binary", "jump"])
def test_find_by_id_all_algorithms(engine, algo):
    r = engine.find_by_id(7, algo)
    assert r["found"] and r["item"]["title"] == "Black wallet" and r["algorithm"] == algo
    assert not engine.find_by_id(8, algo)["found"]


def test_public_view_leaks_nothing_private(engine):
    items = make_items()
    items[0].update(secret="hidden detail", finder_id="uuid-1", code="ABC123")
    engine.load(items)
    assert set(engine.find_by_id(3)["item"]) == {"id", "title", "category", "gate", "tags", "description", "found_at", "status"}


def test_search_keywords_and_prefix(engine):
    assert set(engine.search(q="black")["ids"]) == {3, 7}
    assert engine.search(q="umb")["ids"] == [3]
    assert engine.search(q="nothingmatches")["total"] == 0


def test_search_typo_correction(engine):
    r = engine.search(q="umbrela")
    assert r["did_you_mean"] == "umbrella" and r["ids"] == [3]


def test_search_filters_and_sorting(engine):
    assert engine.search(category="electronics")["ids"] == [9]
    assert engine.search(gate="g-lib")["total"] == 2
    assert engine.search(sort="newest")["ids"][0] == 7
    assert engine.search(sort="oldest")["ids"][0] == 5


@pytest.mark.parametrize("algo", ["linear", "binary"])
def test_search_time_window_same_answer_for_both_algorithms(engine, algo):
    r = engine.search(low=NOW - 4 * 24 * H, high=NOW, algorithm=algo)
    assert set(r["ids"]) == {3, 7, 9}
    assert r["metrics"]["algorithm"] == algo


def test_binary_window_uses_fewer_comparisons():
    e = SearchEngine()
    e.load([{"id": i, "title": f"item {i}", "category": "c", "gate": "g", "tags": [], "found_at": i * 1000, "status": "unclaimed"}
            for i in range(1, 5001)])
    b = e.search(low=1_000_000, high=1_005_000, algorithm="binary")["metrics"]["window_comparisons"]
    l = e.search(low=1_000_000, high=1_005_000, algorithm="linear")["metrics"]["window_comparisons"]
    assert b < 40 and l == 5000


def test_autocomplete(engine):
    assert engine.suggest("bl") == ["blue", "black"]  # shortest word first
    assert engine.suggest("black wa") == ["black wallet"]
    assert engine.suggest("") == [] and engine.suggest("zzz") == []


def test_invalid_inputs_raise(engine):
    with pytest.raises(ValueError):
        engine.search(sort="random")
    with pytest.raises(ValueError):
        engine.search(algorithm="jump")  # jump search is for exact lookups only
    with pytest.raises(ValueError):
        engine.find_by_id(1, "magic")
    with pytest.raises(ValueError):
        engine.find_in_window(10, 5)
    with pytest.raises(ValueError):
        SearchEngine().load([{"id": 1, "title": "x", "status": "unclaimed"}])


def test_empty_engine_is_safe():
    e = SearchEngine()
    assert e.search()["total"] == 0 and e.suggest("a") == [] and not e.find_by_id(1)["found"]
