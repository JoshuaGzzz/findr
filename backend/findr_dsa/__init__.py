"""FINDr DSA engine: searching algorithms, data structures, and the search engine built from them."""
from .engine import SearchEngine
from .searching import (ALGORITHMS, SearchResult, binary_search, binary_search_recursive, jump_search, linear_search,
                        lower_bound, range_search_binary, range_search_linear, upper_bound)
from .sorting import insertion_sort, is_sorted, merge_sort
from .structures import LinkedList, MinHeap, Queue, Stack, Trie

__all__ = [
    "SearchEngine", "ALGORITHMS", "SearchResult", "binary_search", "binary_search_recursive", "jump_search",
    "linear_search", "lower_bound", "upper_bound", "range_search_binary", "range_search_linear", "merge_sort",
    "insertion_sort", "is_sorted", "LinkedList", "MinHeap", "Queue", "Stack", "Trie",
]
