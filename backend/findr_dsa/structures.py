"""Data structures used by FINDr. Each one has a real job in the application:

    Trie        keyword search and autocomplete over item titles/tags
    Queue       claims waiting for staff review (first come, first served)
    Stack       undo of staff actions (last action is undone first)
    MinHeap     retention: which held item is oldest / due for disposal next
    LinkedList  the chain-of-custody trail of one item (append-only history)
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Iterator, List, Optional, Set


# --------------------------------------------------------------------------- linked list
class _Node:
    __slots__ = ("value", "next")

    def __init__(self, value: Any):
        self.value = value
        self.next: Optional[_Node] = None


class LinkedList:
    """Singly linked list with head and tail pointers. append O(1), prepend O(1), find/remove O(n)."""

    def __init__(self, values=()):
        self.head: Optional[_Node] = None
        self.tail: Optional[_Node] = None
        self._size = 0
        for v in values:
            self.append(v)

    def __len__(self) -> int:
        return self._size

    def __iter__(self) -> Iterator:
        node = self.head
        while node:
            yield node.value
            node = node.next

    def append(self, value: Any) -> None:
        node = _Node(value)
        if self.tail:
            self.tail.next = node
        else:
            self.head = node
        self.tail = node
        self._size += 1

    def prepend(self, value: Any) -> None:
        node = _Node(value)
        node.next = self.head
        self.head = node
        if self.tail is None:
            self.tail = node
        self._size += 1

    def pop_front(self) -> Any:
        if self.head is None:
            raise IndexError("pop from empty list")
        node = self.head
        self.head = node.next
        if self.head is None:
            self.tail = None
        self._size -= 1
        return node.value

    def find(self, predicate: Callable[[Any], bool]) -> Optional[Any]:
        for v in self:
            if predicate(v):
                return v
        return None

    def remove(self, predicate: Callable[[Any], bool]) -> bool:
        prev, node = None, self.head
        while node:
            if predicate(node.value):
                if prev:
                    prev.next = node.next
                else:
                    self.head = node.next
                if node is self.tail:
                    self.tail = prev
                self._size -= 1
                return True
            prev, node = node, node.next
        return False

    def reverse(self) -> None:
        prev, node = None, self.head
        self.tail = self.head
        while node:
            node.next, prev, node = prev, node, node.next
        self.head = prev

    def to_list(self) -> List:
        return list(self)


# --------------------------------------------------------------------------- queue
class Queue:
    """FIFO queue built on the linked list: enqueue and dequeue are both O(1)."""

    def __init__(self):
        self._items = LinkedList()

    def __len__(self) -> int:
        return len(self._items)

    def enqueue(self, value: Any) -> None:
        self._items.append(value)

    def dequeue(self) -> Any:
        if not self._items:
            raise IndexError("dequeue from empty queue")
        return self._items.pop_front()

    def peek(self) -> Any:
        if not self._items:
            raise IndexError("peek at empty queue")
        return self._items.head.value

    def is_empty(self) -> bool:
        return len(self._items) == 0

    def to_list(self) -> List:
        return self._items.to_list()


# --------------------------------------------------------------------------- stack
class Stack:
    """LIFO stack with a size cap (oldest entries fall off), used for staff undo. push/pop O(1)."""

    def __init__(self, limit: int = 64):
        if limit < 1:
            raise ValueError("limit must be at least 1")
        self._items: List = []
        self.limit = limit

    def __len__(self) -> int:
        return len(self._items)

    def push(self, value: Any) -> None:
        self._items.append(value)
        if len(self._items) > self.limit:
            del self._items[0]

    def pop(self) -> Any:
        if not self._items:
            raise IndexError("pop from empty stack")
        return self._items.pop()

    def peek(self) -> Any:
        if not self._items:
            raise IndexError("peek at empty stack")
        return self._items[-1]

    def is_empty(self) -> bool:
        return not self._items

    def to_list(self) -> List:
        return list(reversed(self._items))  # top of stack first


# --------------------------------------------------------------------------- heap
class MinHeap:
    """Binary min-heap on a list. push/pop O(log n), peek O(1), build from n items O(n log n)."""

    def __init__(self, key: Callable = lambda x: x):
        self._a: List = []
        self._key = key

    def __len__(self) -> int:
        return len(self._a)

    def push(self, value: Any) -> None:
        a = self._a
        a.append(value)
        i = len(a) - 1
        while i > 0:
            parent = (i - 1) // 2
            if self._key(a[i]) < self._key(a[parent]):
                a[i], a[parent] = a[parent], a[i]
                i = parent
            else:
                break

    def peek(self) -> Any:
        if not self._a:
            raise IndexError("peek at empty heap")
        return self._a[0]

    def pop(self) -> Any:
        a = self._a
        if not a:
            raise IndexError("pop from empty heap")
        top = a[0]
        last = a.pop()
        if a:
            a[0] = last
            i, n = 0, len(a)
            while True:
                l, r, small = 2 * i + 1, 2 * i + 2, i
                if l < n and self._key(a[l]) < self._key(a[small]):
                    small = l
                if r < n and self._key(a[r]) < self._key(a[small]):
                    small = r
                if small == i:
                    break
                a[i], a[small] = a[small], a[i]
                i = small
        return top

    def smallest(self, k: int) -> List:
        """The k smallest items in order, without changing the heap (copies it)."""
        clone = MinHeap(self._key)
        clone._a = list(self._a)
        return [clone.pop() for _ in range(min(k, len(clone)))]


# --------------------------------------------------------------------------- trie
class _TrieNode:
    __slots__ = ("children", "ids", "word")

    def __init__(self):
        self.children: Dict[str, _TrieNode] = {}
        self.ids: Set[Any] = set()  # item ids whose word ends here
        self.word: Optional[str] = None


class Trie:
    """Prefix tree. Finding every word that starts with a prefix costs O(len(prefix) + matches),
    independent of how many items are stored."""

    def __init__(self):
        self.root = _TrieNode()
        self.word_count = 0

    def insert(self, word: str, item_id: Any) -> None:
        node = self.root
        for ch in word:
            node = node.children.setdefault(ch, _TrieNode())
        if node.word is None:
            node.word = word
            self.word_count += 1
        node.ids.add(item_id)

    def remove(self, word: str, item_id: Any) -> None:
        path = [self.root]
        for ch in word:
            nxt = path[-1].children.get(ch)
            if nxt is None:
                return
            path.append(nxt)
        end = path[-1]
        end.ids.discard(item_id)
        if end.ids:
            return
        end.word = None
        self.word_count -= 1
        for i in range(len(word), 0, -1):  # prune empty branches bottom-up
            node = path[i]
            if node.children or node.ids:
                break
            del path[i - 1].children[word[i - 1]]

    def _walk(self, prefix: str) -> Optional[_TrieNode]:
        node = self.root
        for ch in prefix:
            node = node.children.get(ch)
            if node is None:
                return None
        return node

    def has_prefix(self, prefix: str) -> bool:
        return bool(prefix) and self._walk(prefix) is not None

    def search_prefix(self, prefix: str) -> Set[Any]:
        """Ids of every item with a word that starts with `prefix`."""
        node = self._walk(prefix) if prefix else None
        out: Set[Any] = set()
        if node is None:
            return out
        stack = [node]
        while stack:
            n = stack.pop()
            out |= n.ids
            stack.extend(n.children.values())
        return out

    def suggest(self, prefix: str, limit: int = 6) -> List[str]:
        """Autocomplete: words starting with `prefix`, shortest first then alphabetical."""
        node = self._walk(prefix) if prefix else None
        words: List[str] = []
        if node is None:
            return words
        stack = [node]
        while stack:
            n = stack.pop()
            if n.word is not None:
                words.append(n.word)
            stack.extend(n.children.values())
        words.sort(key=lambda w: (len(w), w))
        return words[:limit]
