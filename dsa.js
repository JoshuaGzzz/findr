/* FINDr DSA module: Trie, chained Hash Table, Max-Heap, Stack, sorting/searching, string matching.
   Works in the browser (window.DSA) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DSA = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- Text helpers ---------- */
  function normalize(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function tokenize(s) {
    const n = normalize(s);
    return n ? n.split(" ") : [];
  }

  /* ---------- Trie (prefix tree) ---------- */
  class TrieNode {
    constructor() {
      this.children = new Map();
      this.ids = new Set(); // item ids whose word ends here
    }
  }
  class Trie {
    constructor() {
      this.root = new TrieNode();
      this.wordCount = 0;
    }
    insert(word, id) {
      const w = normalize(word);
      if (!w) return;
      let node = this.root;
      for (const ch of w) {
        if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
        node = node.children.get(ch);
      }
      if (!node.ids.has(id)) {
        node.ids.add(id);
        this.wordCount++;
      }
    }
    insertText(text, id) {
      for (const t of tokenize(text)) this.insert(t, id);
    }
    remove(word, id) {
      const w = normalize(word);
      const path = [];
      let node = this.root;
      for (const ch of w) {
        if (!node.children.has(ch)) return false;
        path.push([node, ch]);
        node = node.children.get(ch);
      }
      if (!node.ids.delete(id)) return false;
      this.wordCount--;
      // prune empty branches
      for (let i = path.length - 1; i >= 0; i--) {
        const [parent, ch] = path[i];
        const child = parent.children.get(ch);
        if (child.ids.size === 0 && child.children.size === 0) parent.children.delete(ch);
        else break;
      }
      return true;
    }
    removeText(text, id) {
      for (const t of tokenize(text)) this.remove(t, id);
    }
    _find(prefix) {
      let node = this.root;
      for (const ch of prefix) {
        node = node.children.get(ch);
        if (!node) return null;
      }
      return node;
    }
    /** Set of ids having any word starting with prefix. */
    searchPrefix(prefix) {
      const p = normalize(prefix);
      const out = new Set();
      if (!p) return out;
      const start = this._find(p);
      if (!start) return out;
      const stack = [start];
      while (stack.length) {
        const n = stack.pop();
        for (const id of n.ids) out.add(id);
        for (const c of n.children.values()) stack.push(c);
      }
      return out;
    }
    /** Word completions for a prefix (for the auto-complete dropdown). */
    suggest(prefix, limit = 6) {
      const p = normalize(prefix);
      const res = [];
      if (!p) return res;
      const start = this._find(p);
      if (!start) return res;
      const walk = (node, acc) => {
        if (res.length >= limit) return;
        if (node.ids.size) res.push(acc);
        const keys = [...node.children.keys()].sort();
        for (const k of keys) walk(node.children.get(k), acc + k);
      };
      walk(start, p);
      return res;
    }
    hasPrefix(prefix) {
      const p = normalize(prefix);
      return p ? !!this._find(p) : false;
    }
  }

  /* ---------- Hash Table with separate chaining (linked lists) ---------- */
  class ChainNode {
    constructor(key, value, next) {
      this.key = key;
      this.value = value;
      this.next = next || null;
    }
  }
  class HashTable {
    constructor(capacity = 16) {
      this.buckets = new Array(capacity).fill(null);
      this.size = 0;
      this.collisions = 0;
    }
    _hash(key) {
      // djb2 string hash
      const s = String(key);
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h % this.buckets.length;
    }
    set(key, value) {
      const i = this._hash(key);
      for (let n = this.buckets[i]; n; n = n.next) {
        if (n.key === key) { n.value = value; return; }
      }
      if (this.buckets[i]) this.collisions++;
      this.buckets[i] = new ChainNode(key, value, this.buckets[i]);
      this.size++;
      if (this.size / this.buckets.length > 0.75) this._resize();
    }
    get(key) {
      for (let n = this.buckets[this._hash(key)]; n; n = n.next) if (n.key === key) return n.value;
      return undefined;
    }
    has(key) { return this.get(key) !== undefined; }
    delete(key) {
      const i = this._hash(key);
      let prev = null;
      for (let n = this.buckets[i]; n; prev = n, n = n.next) {
        if (n.key === key) {
          if (prev) prev.next = n.next; else this.buckets[i] = n.next;
          this.size--;
          return true;
        }
      }
      return false;
    }
    _resize() {
      const old = this.buckets;
      this.buckets = new Array(old.length * 2).fill(null);
      this.size = 0;
      this.collisions = 0;
      for (const head of old) for (let n = head; n; n = n.next) this.set(n.key, n.value);
    }
    keys() { const o = []; for (const h of this.buckets) for (let n = h; n; n = n.next) o.push(n.key); return o; }
    values() { const o = []; for (const h of this.buckets) for (let n = h; n; n = n.next) o.push(n.value); return o; }
    longestChain() {
      let m = 0;
      for (const h of this.buckets) { let c = 0; for (let n = h; n; n = n.next) c++; if (c > m) m = c; }
      return m;
    }
  }

  /* ---------- Max-Heap / Priority Queue ---------- */
  class MaxHeap {
    /** cmp(a,b) > 0 means a has higher priority than b. Default: numeric priority field. */
    constructor(cmp) {
      this.a = [];
      this.cmp = cmp || ((x, y) => x.priority - y.priority);
    }
    get size() { return this.a.length; }
    peek() { return this.a[0]; }
    push(v) {
      const a = this.a;
      a.push(v);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.cmp(a[i], a[p]) <= 0) break;
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      }
    }
    pop() {
      const a = this.a;
      if (!a.length) return undefined;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && this.cmp(a[l], a[m]) > 0) m = l;
          if (r < a.length && this.cmp(a[r], a[m]) > 0) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]];
          i = m;
        }
      }
      return top;
    }
    /** Non-destructive ranked list (highest priority first). */
    ranked(limit = Infinity) {
      const copy = new MaxHeap(this.cmp);
      copy.a = this.a.slice();
      const out = [];
      while (copy.size && out.length < limit) out.push(copy.pop());
      return out;
    }
    static from(items, cmp) {
      const h = new MaxHeap(cmp);
      for (const it of items) h.push(it);
      return h;
    }
  }

  /* ---------- Stack (array-backed LIFO) ---------- */
  class Stack {
    constructor() { this.items = []; }
    push(v) { this.items.push(v); }
    pop() { return this.items.pop(); }
    peek() { return this.items[this.items.length - 1]; }
    get size() { return this.items.length; }
    isEmpty() { return this.items.length === 0; }
    toArray() { return this.items.slice(); } // bottom -> top
  }

  /* ---------- Sorting & Searching ---------- */
  function mergeSort(arr, cmp) {
    cmp = cmp || ((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (arr.length <= 1) return arr.slice();
    const mid = arr.length >> 1;
    const l = mergeSort(arr.slice(0, mid), cmp);
    const r = mergeSort(arr.slice(mid), cmp);
    const out = [];
    let i = 0, j = 0;
    while (i < l.length && j < r.length) out.push(cmp(l[i], r[j]) <= 0 ? l[i++] : r[j++]); // stable
    while (i < l.length) out.push(l[i++]);
    while (j < r.length) out.push(r[j++]);
    return out;
  }
  /** First index in sorted arr whose keyFn(item) >= target (arr ascending by keyFn). */
  function lowerBound(arr, target, keyFn) {
    keyFn = keyFn || ((x) => x);
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keyFn(arr[mid]) < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function binarySearch(arr, target, keyFn) {
    keyFn = keyFn || ((x) => x);
    const i = lowerBound(arr, target, keyFn);
    return i < arr.length && keyFn(arr[i]) === target ? i : -1;
  }
  /** Items with lo <= key <= hi from an array sorted ascending by keyFn. */
  function rangeQuery(arr, lo, hi, keyFn) {
    keyFn = keyFn || ((x) => x);
    const out = [];
    for (let i = lowerBound(arr, lo, keyFn); i < arr.length && keyFn(arr[i]) <= hi; i++) out.push(arr[i]);
    return out;
  }

  /* ---------- String validation for claims / matching ---------- */
  function levenshtein(a, b) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  const STOPWORDS = new Set(["the", "and", "with", "has", "have", "there", "this", "that", "its", "for", "are", "was", "from", "near", "some"]);
  /** 0..1 similarity between two single words. */
  function wordSimilarity(a, b) {
    const m = Math.max(a.length, b.length);
    return m ? 1 - levenshtein(a, b) / m : 1;
  }
  /**
   * How well does the owner's claimed text match the private details on file?
   * Each secret token is satisfied by a close claimed token (typo tolerant).
   * Returns { score 0..1, matched[], missed[] }.
   */
  function claimMatch(secret, claimed) {
    const sec = [...new Set(tokenize(secret))].filter((t) => t.length > 2 && !STOPWORDS.has(t));
    const cl = tokenize(claimed);
    if (!sec.length) return { score: 0, matched: [], missed: [] };
    const matched = [], missed = [];
    for (const s of sec) {
      const ok = cl.some((c) => c === s || (s.length > 3 && wordSimilarity(c, s) >= 0.75));
      (ok ? matched : missed).push(s);
    }
    return { score: matched.length / sec.length, matched, missed };
  }

  return { normalize, tokenize, Trie, HashTable, MaxHeap, Stack, mergeSort, lowerBound, binarySearch, rangeQuery, levenshtein, wordSimilarity, claimMatch };
});
