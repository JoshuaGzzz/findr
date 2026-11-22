const assert = require("assert");
const D = require("./dsa.js");
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok -", name); };

t("trie prefix search + suggest + remove", () => {
  const tr = new D.Trie();
  tr.insertText("Black Umbrella", 1);
  tr.insertText("Blue Water Bottle", 2);
  tr.insertText("Bluetooth Earbuds", 3);
  assert.deepStrictEqual([...tr.searchPrefix("blu")].sort(), [2, 3]);
  assert.deepStrictEqual([...tr.searchPrefix("bla")], [1]);
  assert.strictEqual(tr.searchPrefix("zzz").size, 0);
  assert.deepStrictEqual(tr.suggest("blue"), ["blue", "bluetooth"]);
  tr.removeText("Bluetooth Earbuds", 3);
  assert.deepStrictEqual([...tr.searchPrefix("blu")], [2]);
  assert.strictEqual(tr.hasPrefix("earb"), false);
});

t("hash table chaining, collisions, resize, delete", () => {
  const h = new D.HashTable(2);
  for (let i = 0; i < 200; i++) h.set("k" + i, i);
  assert.strictEqual(h.size, 200);
  for (let i = 0; i < 200; i++) assert.strictEqual(h.get("k" + i), i);
  assert.strictEqual(h.get("nope"), undefined);
  h.set("k5", 555);
  assert.strictEqual(h.get("k5"), 555);
  assert.strictEqual(h.size, 200);
  assert.ok(h.delete("k5"));
  assert.ok(!h.delete("k5"));
  assert.strictEqual(h.size, 199);
  assert.strictEqual(h.keys().length, 199);
  const tiny = new D.HashTable(1); // force chains
  tiny.buckets = [null];
  tiny.set("a", 1); tiny.set("b", 2); tiny.set("c", 3);
});

t("max-heap ordering", () => {
  const h = new D.MaxHeap();
  [5, 1, 9, 3, 7, 9, 2].forEach((p) => h.push({ priority: p }));
  assert.strictEqual(h.peek().priority, 9);
  assert.deepStrictEqual(h.ranked(3).map((x) => x.priority), [9, 9, 7]);
  assert.strictEqual(h.size, 7);
  const out = []; while (h.size) out.push(h.pop().priority);
  assert.deepStrictEqual(out, [9, 9, 7, 5, 3, 2, 1]);
  assert.strictEqual(h.pop(), undefined);
});

t("stack LIFO", () => {
  const s = new D.Stack();
  s.push("pending"); s.push("unclaimed"); s.push("claimed");
  assert.strictEqual(s.peek(), "claimed");
  assert.strictEqual(s.pop(), "claimed");
  assert.deepStrictEqual(s.toArray(), ["pending", "unclaimed"]);
  s.pop(); s.pop();
  assert.ok(s.isEmpty());
  assert.strictEqual(s.pop(), undefined);
});

t("merge sort is correct and stable", () => {
  const rnd = Array.from({ length: 500 }, () => Math.floor(Math.random() * 100));
  const sorted = D.mergeSort(rnd, (a, b) => a - b);
  assert.deepStrictEqual(sorted, rnd.slice().sort((a, b) => a - b));
  const rec = [{ k: 1, n: "a" }, { k: 0, n: "b" }, { k: 1, n: "c" }, { k: 0, n: "d" }];
  assert.deepStrictEqual(D.mergeSort(rec, (x, y) => x.k - y.k).map((r) => r.n), ["b", "d", "a", "c"]);
});

t("binary search, lowerBound, rangeQuery", () => {
  const a = [{ t: 10 }, { t: 20 }, { t: 20 }, { t: 30 }, { t: 40 }];
  const key = (x) => x.t;
  assert.strictEqual(D.binarySearch(a, 30, key), 3);
  assert.strictEqual(D.binarySearch(a, 25, key), -1);
  assert.strictEqual(D.lowerBound(a, 20, key), 1);
  assert.strictEqual(D.lowerBound(a, 99, key), 5);
  assert.deepStrictEqual(D.rangeQuery(a, 15, 30, key).map(key), [20, 20, 30]);
});

t("levenshtein and claim matching", () => {
  assert.strictEqual(D.levenshtein("kitten", "sitting"), 3);
  assert.strictEqual(D.levenshtein("", "abc"), 3);
  const m = D.claimMatch("Scratch on the corner, Naruto sticker", "there is a naruto stiker and a scratch near the corner");
  assert.strictEqual(m.score, 1);
  assert.ok(!m.missed.includes("the"));
  const bad = D.claimMatch("Scratch on the corner, Naruto sticker", "a red case");
  assert.ok(bad.score < 0.5);
  assert.deepStrictEqual(D.claimMatch("", "x").matched, []);
});

console.log(`\n${passed} test groups passed`);
