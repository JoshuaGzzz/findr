"""Text helpers for keyword search: normalising, tokenising, and typo tolerance."""
from __future__ import annotations

import re
import unicodedata
from typing import List

STOPWORDS = {"a", "an", "the", "of", "and", "or", "with", "my", "at", "in", "on", "to", "for", "is", "it"}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]+", " ", text.lower()).strip()


def tokenize(text: str) -> List[str]:
    return [t for t in normalize(text).split() if t]


def clean_tokens(text: str) -> List[str]:
    """Tokens without stopwords and one-letter noise."""
    return [t for t in tokenize(text) if t not in STOPWORDS and len(t) > 1]


def levenshtein(a: str, b: str) -> int:
    """Edit distance by dynamic programming: O(len(a) * len(b)) time, O(len(b)) space."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def word_similarity(a: str, b: str) -> float:
    """1.0 for identical words, falling toward 0 as the edit distance grows."""
    longest = max(len(a), len(b))
    return 1.0 if longest == 0 else 1 - levenshtein(a, b) / longest
