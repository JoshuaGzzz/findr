/* FINDr domain layer: lifecycle, search, smart matching, secure claims, retention, audit.
   Built on dsa.js. Works in the browser (window.FindrStore) and Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./dsa.js"));
  else root.FindrStore = factory(root.DSA);
})(typeof self !== "undefined" ? self : this, function (DSA) {
  "use strict";
  const { Trie, HashTable, MaxHeap, Stack, mergeSort, lowerBound, rangeQuery, tokenize, normalize, claimMatch, wordSimilarity } = DSA;

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const STAFF_PIN = "2026";
  const S = { PENDING: "PENDING_DROPOFF", UNCLAIMED: "UNCLAIMED", CLAIM_PENDING: "CLAIM_PENDING", CLAIMED: "CLAIMED", ARCHIVED: "ARCHIVED" };
  const LABEL = { PENDING_DROPOFF: "Pending Drop-Off", UNCLAIMED: "Unclaimed", CLAIM_PENDING: "Claim Pending", CLAIMED: "Claimed", ARCHIVED: "Archived" };
  const ALLOWED = {
    PENDING_DROPOFF: ["UNCLAIMED", "ARCHIVED"],
    UNCLAIMED: ["CLAIM_PENDING", "ARCHIVED"],
    CLAIM_PENDING: ["CLAIMED", "UNCLAIMED"],
    CLAIMED: ["ARCHIVED"],
    ARCHIVED: [],
  };
  const CATEGORIES = [
    ["bags", "Bags"], ["electronics", "Electronics"], ["wallets", "Wallets & Cards"], ["ids", "IDs"],
    ["keys", "Keys"], ["clothing", "Clothing"], ["umbrellas", "Umbrellas"], ["bottles", "Bottles"],
    ["stationery", "Books & Stationery"], ["accessories", "Accessories"], ["other", "Other"],
  ];
  const GATES = [["g-main", "Main Gate"], ["g-eng", "Engineering Gate"], ["g-lib", "Library Entrance"], ["g-gym", "Gymnasium Gate"]];

  /* Vocabulary / taxonomy mismatch: synonym groups (English, Filipino, brand names). */
  const SYN_GROUPS = [
    ["umbrella", "payong", "parasol"],
    ["phone", "cellphone", "mobile", "smartphone", "iphone", "android", "cp", "samsung"],
    ["wallet", "purse", "billfold", "pitaka", "cardholder"],
    ["bag", "backpack", "bagpack", "knapsack", "sling", "tote", "satchel", "handbag"],
    ["bottle", "tumbler", "flask", "hydroflask", "hydro", "canteen"],
    ["earbuds", "earphones", "airpods", "earpods", "headphones", "headset"],
    ["id", "identification", "lanyard"],
    ["key", "keys", "susi", "keychain", "keyring"],
    ["laptop", "macbook", "chromebook", "notebookpc"],
    ["charger", "cable", "adapter", "powerbank"],
    ["jacket", "hoodie", "sweater", "jumper", "cardigan", "coat", "raincoat"],
    ["glasses", "eyeglasses", "spectacles", "specs", "salamin"],
    ["calculator", "calc", "casio"],
    ["book", "textbook", "notebook", "reviewer"],
    ["pen", "ballpen", "pencil", "marker"],
    ["watch", "wristwatch", "smartwatch"],
  ];
  const stem = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is") ? w.slice(0, -1) : w);
  const SYN = new HashTable(128); // word -> group index
  SYN_GROUPS.forEach((g, i) => g.forEach((w) => { SYN.set(w, i); SYN.set(stem(w), i); }));
  const synGroup = (w) => { const a = SYN.get(w); return a !== undefined ? a : SYN.get(stem(w)); };

  const STOP = new Set(["a", "an", "the", "and", "or", "of", "on", "in", "at", "to", "with", "for", "is", "it", "its", "was", "has", "have", "my", "me", "near", "this", "that", "some"]);
  const MATCH_STOP = new Set(["lost", "found", "missing", "please", "item", "thing", "color", "colour"]);
  const cleanTokens = (text) => tokenize(text).filter((t) => t.length > 1 && !STOP.has(t));
  const canon = (t) => { const g = synGroup(t); return g === undefined ? stem(t) : "g" + g; };
  const withSynonyms = (tokens) => {
    const out = new Set(tokens);
    for (const t of tokens) { const g = synGroup(t); if (g !== undefined) SYN_GROUPS[g].forEach((w) => out.add(w)); }
    return [...out];
  };

  const MATCH_THRESHOLD = 0.55;
  const CLAIM_PASS = 0.5;
  const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  class Store {
    constructor(opts = {}) {
      this.clock = opts.clock || (() => Date.now());
      this.rng = opts.rng || Math.random;
      this.storage = opts.storage || null;
      this.storageKey = opts.storageKey || "findr.v1";
      this.storageError = false;
      this._reset();
      this.loaded = this._load();
      if (this.loaded) this.sweepRetention();
    }

    /* ===== state ===== */
    _reset() {
      this.items = new HashTable(64);
      this.categories = new HashTable(16);
      this.gates = new HashTable(8);
      this.sessions = new HashTable(16);
      this.codes = new HashTable(64);
      this.attempts = new HashTable(16);
      this.strikes = new HashTable(16);
      this.titleGroups = new HashTable(64);
      this.vocab = new HashTable(128);
      this.alertKeys = new HashTable(32);
      this.history = new HashTable(64); // itemId -> Stack of transitions
      this.undoStack = new Stack(); // global LIFO of transitions
      this.trie = new Trie(); // searchable items
      this.reportTrie = new Trie(); // open missing-item reports
      this.byTime = []; // all items sorted ascending by foundAt
      this.reports = []; this.claims = []; this.alerts = []; this.audit = [];
      this.settings = { retentionDays: 30 };
      this.seq = { item: 0, report: 0, claim: 0, alert: 0, audit: 0 };
      CATEGORIES.forEach(([id, label]) => this.categories.set(id, { id, label, count: 0 }));
      GATES.forEach(([id, name]) => this.gates.set(id, { id, name }));
    }
    now() { return this.clock(); }

    _save() {
      if (!this.storage) return;
      try {
        const snap = {
          v: 1,
          items: this.items.values().map((it) => JSON.parse(JSON.stringify(it, (k, v) => (k[0] === "_" ? undefined : v)))),
          reports: this.reports, claims: this.claims, alerts: this.alerts, audit: this.audit,
          history: this.history.keys().map((k) => [k, this.history.get(k).toArray()]),
          undo: this.undoStack.toArray(),
          attempts: this.attempts.keys().map((k) => [k, this.attempts.get(k)]),
          strikes: this.strikes.keys().map((k) => [k, this.strikes.get(k)]),
          sessions: this.sessions.values(),
          settings: this.settings, seq: this.seq,
        };
        this.storage.setItem(this.storageKey, JSON.stringify(snap));
        this.storageError = false;
      } catch (e) { this.storageError = true; }
    }
    _load() {
      if (!this.storage) return false;
      let snap;
      try { snap = JSON.parse(this.storage.getItem(this.storageKey) || "null"); } catch (e) { snap = null; }
      if (!snap || snap.v !== 1) return false;
      this.settings = snap.settings; this.seq = snap.seq;
      this.reports = snap.reports; this.claims = snap.claims; this.alerts = snap.alerts; this.audit = snap.audit;
      for (const it of snap.items) this._ingestItem(it);
      for (const [k, arr] of snap.history) { const st = new Stack(); arr.forEach((e) => st.push(e)); this.history.set(k, st); }
      snap.undo.forEach((id) => this.undoStack.push(id));
      snap.attempts.forEach(([k, v]) => this.attempts.set(k, v));
      snap.strikes.forEach(([k, v]) => this.strikes.set(k, v));
      snap.sessions.forEach((s) => this.sessions.set(s.token, s));
      for (const r of this.reports) { r.alertKeys = undefined; if (r.status === "OPEN") this._indexReport(r); }
      for (const a of this.alerts) this.alertKeys.set(a.reportId + "|" + a.itemId, a.id);
      return true;
    }
    /* Load one item into every index (hash table, title groups, time order, codes, trie). Used by _load and by remote stores. */
    _ingestItem(it) {
      this.items.set(it.id, it);
      this._groupAdd(it);
      this.byTime.splice(lowerBound(this.byTime, it.foundAt + 1, (x) => x.foundAt), 0, it);
      if (it.status === S.PENDING && it.code) this.codes.set(it.code, it.id);
      if (this._searchable(it)) this._index(it);
    }
    clearAll() { if (this.storage) { try { this.storage.removeItem(this.storageKey); } catch (e) {} } this._reset(); }

    /* ===== sessions & permissions ===== */
    login(role, { name, studentId, pin } = {}) {
      name = String(name || "").trim();
      studentId = String(studentId || "").trim();
      if (name.length < 2) throw new Error("Please enter your name.");
      if (role === "staff") {
        if (pin !== STAFF_PIN) throw new Error("Incorrect staff PIN.");
        studentId = studentId || "STAFF";
      } else {
        if (!/^[A-Za-z0-9-]{4,16}$/.test(studentId)) throw new Error("Enter a valid student / employee ID (4–16 letters, digits or dashes).");
        role = "student";
      }
      const token = "T" + Math.floor(this.rng() * 1e9).toString(36) + this.now().toString(36);
      const s = { token, role, name, studentId, at: this.now(), submissions: [] };
      this.sessions.set(token, s);
      this._save();
      return s;
    }
    logout(token) { this.sessions.delete(token); this._save(); }
    session(token) { return token ? this.sessions.get(token) || null : null; }
    _need(token, role) {
      const s = this.session(token);
      if (!s) throw new Error("Please sign in first.");
      if (role && s.role !== role) throw new Error(role === "staff" ? "Staff access only." : "Students and employees only.");
      return s;
    }

    /* ===== audit + history (Stack) ===== */
    _log(actor, action, itemId, detail) {
      const e = { seq: ++this.seq.audit, at: this.now(), actor: actor.name, role: actor.role, action, itemId: itemId || null, detail: detail || "" };
      this.audit.push(e);
      return e;
    }
    _hist(id) { let st = this.history.get(id); if (!st) { st = new Stack(); this.history.set(id, st); } return st; }
    _transition(item, to, actor, type, extra = {}) {
      const from = item.status;
      if (!ALLOWED[from].includes(to)) throw new Error(`Cannot move an item from ${LABEL[from]} to ${LABEL[to]}.`);
      const wasSearchable = this._searchable(item);
      item.status = to;
      this._hist(item.id).push({ type, from, to, at: this.now(), actor: actor.name, ...extra });
      this.undoStack.push(item.id);
      this._reindex(item, wasSearchable);
    }

    /* ===== indexing ===== */
    _searchable(it) { return it.status === S.UNCLAIMED || it.status === S.CLAIM_PENDING; }
    _tokens(it) { return [...new Set(cleanTokens([it.title, it.tags.join(" "), this.categories.get(it.category).label, it.description].join(" ")))]; }
    _index(it) {
      it._idx = withSynonyms(this._tokens(it));
      for (const w of it._idx) { this.trie.insert(w, it.id); this.vocab.set(w, (this.vocab.get(w) || 0) + 1); }
      this.categories.get(it.category).count++;
    }
    _unindex(it) {
      for (const w of it._idx || []) {
        this.trie.remove(w, it.id);
        const c = (this.vocab.get(w) || 1) - 1;
        if (c <= 0) this.vocab.delete(w); else this.vocab.set(w, c);
      }
      it._idx = [];
      this.categories.get(it.category).count--;
    }
    _reindex(it, wasSearchable) {
      const now = this._searchable(it);
      if (wasSearchable && !now) this._unindex(it);
      else if (!wasSearchable && now) this._index(it);
    }
    _groupKey(it) { return it.category + "|" + normalize(it.title); }
    _groupAdd(it) { const k = this._groupKey(it); const a = this.titleGroups.get(k) || []; a.push(it.id); this.titleGroups.set(k, a); }
    _indexReport(r) { for (const w of withSynonyms(cleanTokens([r.title, r.tags.join(" "), r.description].join(" ")))) this.reportTrie.insert(w, r.id); }
    _unindexReport(r) { for (const w of withSynonyms(cleanTokens([r.title, r.tags.join(" "), r.description].join(" ")))) this.reportTrie.remove(w, r.id); }

    /* ===== views (what each audience may see) ===== */
    publicItem(it) {
      const g = this.titleGroups.get(this._groupKey(it)) || [];
      const twins = g.filter((id) => id !== it.id && this._searchable(this.items.get(id))).length;
      return {
        id: it.id, title: it.title, category: it.category, categoryLabel: this.categories.get(it.category).label,
        tags: it.tags, description: it.description, gate: it.gate, gateName: this.gates.get(it.gate).name,
        foundAt: it.foundAt, status: it.status, statusLabel: LABEL[it.status], photo: it.photo || null, lookalikes: twins,
      };
    }
    staffItem(it) {
      const age = (this.now() - it.foundAt) / DAY;
      return { ...this.publicItem(it), secret: it.secret || "", finderName: it.finderName, finderId: it.finderId, code: it.code || null, flaggedAt: it.flaggedAt || null, disposition: it.disposition || null, source: it.source, ageDays: age, createdAt: it.createdAt };
    }
    getItem(id, staff) { const it = this.items.get(id); if (!it) return null; return staff ? this.staffItem(it) : this.publicItem(it); }
    lookalikes(id) {
      const it = this.items.get(id);
      if (!it) return [];
      const ids = (this.titleGroups.get(this._groupKey(it)) || []).map((i) => this.items.get(i)).filter((x) => this._searchable(x));
      return mergeSort(ids, (a, b) => a.foundAt - b.foundAt).map((x) => this.publicItem(x));
    }

    /* ===== search (Trie + sorting + binary search range) ===== */
    suggest(text, limit = 6) {
      const toks = tokenize(text);
      if (!toks.length) return [];
      const last = toks.pop();
      const head = toks.join(" ");
      return this.trie.suggest(last, limit).map((w) => (head ? head + " " : "") + w);
    }
    search({ q = "", category = "", gate = "", from = null, to = null, sort = "relevance" } = {}) {
      const toks = cleanTokens(q);
      let didYouMean = null;
      const scores = new Map();
      if (!toks.length) {
        for (const it of this.byTime) if (this._searchable(it)) scores.set(it.id, 0);
      } else {
        let corrected = false;
        const fixed = toks.map((t) => {
          if (this.trie.hasPrefix(t)) return t;
          let best = null, bs = 0;
          for (const w of this.vocab.keys()) { const s = wordSimilarity(t, w); if (s > bs) { bs = s; best = w; } }
          if (best && bs >= 0.75) { corrected = true; return best; }
          return t;
        });
        if (corrected) didYouMean = fixed.join(" ");
        const sets = fixed.map((t) => this.trie.searchPrefix(t));
        const order = sets.map((s, i) => i).sort((a, b) => sets[a].size - sets[b].size);
        let inter = new Set(sets[order[0]]);
        for (const i of order.slice(1)) inter = new Set([...inter].filter((id) => sets[i].has(id)));
        const pool = inter.size ? inter : new Set(sets.flatMap((s) => [...s])); // fall back to any-word match
        for (const id of pool) {
          const it = this.items.get(id);
          const titleToks = cleanTokens(it.title);
          let sc = 0;
          for (let i = 0; i < fixed.length; i++) {
            if (!sets[i].has(id)) continue;
            sc += titleToks.some((w) => w.startsWith(fixed[i])) ? 3 : 1;
          }
          scores.set(id, sc);
        }
      }
      let ids = [...scores.keys()];
      if (from != null || to != null) {
        const inRange = new Set(rangeQuery(this.byTime, from == null ? -Infinity : from, to == null ? Infinity : to, (x) => x.foundAt).map((x) => x.id));
        ids = ids.filter((id) => inRange.has(id));
      }
      let rows = ids.map((id) => this.items.get(id)).filter((it) => (!category || it.category === category) && (!gate || it.gate === gate));
      const cmp = sort === "oldest" ? (a, b) => a.foundAt - b.foundAt
        : sort === "newest" ? (a, b) => b.foundAt - a.foundAt
        : (a, b) => scores.get(b.id) - scores.get(a.id) || b.foundAt - a.foundAt;
      rows = mergeSort(rows, cmp);
      return { results: rows.map((it) => ({ item: this.publicItem(it), score: scores.get(it.id) })), didYouMean, total: rows.length };
    }

    /* ===== validation helpers ===== */
    _looksSpammy(text) {
      const t = String(text || "");
      if (/(.)\1{5,}/.test(t)) return true;
      if (/https?:\/\/|www\.|\.com\b/i.test(t)) return true;
      const letters = t.replace(/[^a-z]/gi, "");
      if (letters.length >= 6 && !/[aeiou]/i.test(letters)) return true;
      return false;
    }
    _fields(data, staff) {
      const title = String(data.title || "").trim();
      if (title.length < 3 || title.length > 60) throw new Error("Give the item a short title (3–60 characters).");
      const description = String(data.description || "").trim().slice(0, 300);
      if (this._looksSpammy(title) || this._looksSpammy(description)) throw new Error("That entry looks like spam. Please describe the item plainly.");
      if (!this.categories.has(data.category)) throw new Error("Choose a category.");
      if (!this.gates.has(data.gate)) throw new Error("Choose a gate or location.");
      const tags = [...new Set(String(Array.isArray(data.tags) ? data.tags.join(",") : data.tags || "").split(/[,;\n]/).map((x) => normalize(x)).filter(Boolean))].slice(0, 8);
      const foundAt = Number(data.foundAt) || this.now();
      if (foundAt > this.now() + 5 * MIN) throw new Error("The time found can't be in the future.");
      if (!staff && foundAt < this.now() - 7 * DAY) throw new Error("Self-service reports must be within the last 7 days. Bring older items to the security office.");
      return { title, description, category: data.category, gate: data.gate, tags, foundAt };
    }
    _newCode() {
      for (;;) {
        let c = "";
        for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(this.rng() * CODE_ALPHABET.length)];
        if (!this.codes.has(c)) return c;
      }
    }

    /* ===== intake (self-service = pending; staff = straight to Unclaimed) ===== */
    createFoundItem(token, data) {
      const s = this._need(token);
      const staff = s.role === "staff";
      if (!staff) {
        if ((this.strikes.get(s.studentId) || 0) >= 2) throw new Error("Self-service reports are paused on your account. Please hand items directly to campus security.");
        if (data.website) throw new Error("Submission blocked.");
        s.submissions = s.submissions.filter((t) => t > this.now() - 10 * MIN);
        if (s.submissions.length >= 3) throw new Error("Too many reports in a short time. Try again in a few minutes.");
      }
      const f = this._fields(data, staff);
      const dupKey = this._groupKey(f) + "|" + f.gate;
      const dup = this.items.values().find((it) => this._groupKey(it) + "|" + it.gate === dupKey && it.createdAt > this.now() - 10 * MIN && it.finderId === s.studentId);
      if (dup) throw new Error("You already reported this item a moment ago.");
      const it = {
        id: "I-" + String(++this.seq.item).padStart(4, "0"), ...f,
        photo: data.photo || null, secret: String(data.secret || "").trim().slice(0, 300),
        status: staff ? S.UNCLAIMED : S.PENDING, finderName: s.name, finderId: s.studentId,
        source: staff ? "staff" : "self-service", createdAt: this.now(), code: null,
      };
      if (!staff) { it.code = this._newCode(); this.codes.set(it.code, it.id); s.submissions.push(this.now()); }
      this.items.set(it.id, it);
      this._groupAdd(it);
      this.byTime.splice(lowerBound(this.byTime, it.foundAt + 1, (x) => x.foundAt), 0, it);
      this._hist(it.id).push({ type: "create", from: null, to: it.status, at: this.now(), actor: s.name });
      if (this._searchable(it)) this._index(it);
      this._log(s, "ITEM_LOGGED", it.id, `${it.title} @ ${this.gates.get(it.gate).name} (${staff ? "staff intake" : "self-service, awaiting drop-off"})`);
      const alerts = this._searchable(it) ? this._matchItemAgainstReports(it, s) : [];
      this._save();
      return { item: this.staffItem(it), alerts: alerts.length };
    }

    /* ===== staff: verify drop-off, reject spam ===== */
    pendingQueue(gate) {
      const rows = this.items.values().filter((it) => it.status === S.PENDING && (!gate || it.gate === gate));
      return mergeSort(rows, (a, b) => a.createdAt - b.createdAt).map((it) => ({ ...this.staffItem(it), stale: this.now() - it.createdAt > 48 * HOUR }));
    }
    receiveItem(token, idOrCode, secret) {
      const s = this._need(token, "staff");
      const key = String(idOrCode || "").trim().toUpperCase();
      const id = this.codes.get(key) || (this.items.has(idOrCode) ? idOrCode : null);
      const it = id && this.items.get(id);
      if (!it) throw new Error("No pending item matches that drop-off code.");
      if (it.status !== S.PENDING) throw new Error(`${it.id} is already ${LABEL[it.status]}.`);
      if (secret != null && String(secret).trim()) it.secret = String(secret).trim().slice(0, 300);
      this._transition(it, S.UNCLAIMED, s, "receive");
      this.codes.delete(it.code);
      this._log(s, "ITEM_VERIFIED", it.id, `Physically received at ${this.gates.get(it.gate).name}`);
      const alerts = this._matchItemAgainstReports(it, s);
      this._save();
      return { item: this.staffItem(it), alerts: alerts.length };
    }
    rejectPending(token, id, reason) {
      const s = this._need(token, "staff");
      const it = this.items.get(id);
      if (!it || it.status !== S.PENDING) throw new Error("Only pending items can be rejected.");
      this._transition(it, S.ARCHIVED, s, "rejectPending", { reason: reason || "spam" });
      this.codes.delete(it.code);
      this.strikes.set(it.finderId, (this.strikes.get(it.finderId) || 0) + 1);
      this._log(s, "PENDING_REJECTED", it.id, `Rejected (${reason || "spam / never dropped off"}); strike on ${it.finderId}`);
      this._save();
      return this.staffItem(it);
    }

    /* ===== secure claim verification ===== */
    submitClaim(token, itemId, details, contact) {
      const s = this._need(token, "student");
      const it = this.items.get(itemId);
      if (!it) throw new Error("Item not found.");
      if (it.status !== S.UNCLAIMED) throw new Error(it.status === S.CLAIM_PENDING ? "Someone has already started a claim on this item. Visit the security office if it's yours." : "This item can't be claimed right now.");
      if (it.finderId === s.studentId) throw new Error("You reported this item, so you can't claim it. Ask security if you need help.");
      details = String(details || "").trim();
      if (details.length < 8) throw new Error("Describe at least one detail that only the owner would know.");
      const ak = s.studentId + "|" + it.id;
      if ((this.attempts.get(ak) || 0) >= 3) throw new Error("Too many unsuccessful attempts. Please visit the security office with a valid ID.");
      const manual = !it.secret;
      const m = manual ? { score: null, matched: [], missed: [] } : claimMatch(it.secret, details);
      if (!manual && m.score < CLAIM_PASS) {
        this.attempts.set(ak, (this.attempts.get(ak) || 0) + 1);
        this._log(s, "CLAIM_FAILED", it.id, `Details did not match (attempt ${this.attempts.get(ak)} of 3)`);
        this._save();
        return { ok: false, attemptsLeft: 3 - this.attempts.get(ak), message: "Those details don't match what security has on file. Think about marks, stickers, contents or the lock screen, and try again." };
      }
      const claim = { id: "C-" + String(++this.seq.claim).padStart(4, "0"), itemId: it.id, claimantId: s.studentId, claimantName: s.name, contact: String(contact || "").trim().slice(0, 80), details: details.slice(0, 300), score: m.score, matched: m.matched, missed: m.missed, manual, at: this.now(), status: "PENDING" };
      this.claims.push(claim);
      this._transition(it, S.CLAIM_PENDING, s, "claim", { claimId: claim.id });
      this._log(s, "CLAIM_SUBMITTED", it.id, manual ? "No private detail on file: manual check needed" : `Detail match ${Math.round(m.score * 100)}%`);
      this._save();
      return { ok: true, claim };
    }
    claimQueue() {
      return this.claims.filter((c) => c.status === "PENDING").map((c) => ({ claim: c, item: this.staffItem(this.items.get(c.itemId)) }));
    }
    approveClaim(token, claimId) {
      const s = this._need(token, "staff");
      const c = this.claims.find((x) => x.id === claimId && x.status === "PENDING");
      if (!c) throw new Error("Claim not found or already decided.");
      const it = this.items.get(c.itemId);
      c.status = "APPROVED"; c.decidedAt = this.now();
      it.claimedBy = c.claimantId; it.claimedAt = this.now();
      this._transition(it, S.CLAIMED, s, "approve", { claimId });
      this._log(s, "CLAIM_APPROVED", it.id, `Released to ${c.claimantName} (${c.claimantId}) after ID check`);
      this._save();
      return this.staffItem(it);
    }
    rejectClaim(token, claimId, reason) {
      const s = this._need(token, "staff");
      const c = this.claims.find((x) => x.id === claimId && x.status === "PENDING");
      if (!c) throw new Error("Claim not found or already decided.");
      const it = this.items.get(c.itemId);
      c.status = "REJECTED"; c.decidedAt = this.now();
      this._transition(it, S.UNCLAIMED, s, "rejectClaim", { claimId });
      this._log(s, "CLAIM_REJECTED", it.id, `Claim by ${c.claimantName} rejected${reason ? ": " + reason : ""}`);
      this._save();
      return this.staffItem(it);
    }

    /* ===== retention (Max-Heap by age) ===== */
    setRetention(token, days) {
      const s = this._need(token, "staff");
      const d = Math.max(30, Math.min(60, Math.round(Number(days) || 30)));
      this.settings.retentionDays = d;
      this._log(s, "RETENTION_SET", null, `Retention limit set to ${d} days`);
      this.sweepRetention();
      this._save();
      return d;
    }
    _retentionHeap() {
      const h = new MaxHeap((a, b) => a.priority - b.priority || (a.item.id < b.item.id ? 1 : -1));
      for (const it of this.items.values()) if (it.status === S.UNCLAIMED) h.push({ item: it, priority: this.now() - it.foundAt });
      return h;
    }
    retentionQueue(limit = 50) {
      const lim = this.settings.retentionDays;
      return this._retentionHeap().ranked(limit).map(({ item, priority }) => ({ item: this.staffItem(item), ageDays: priority / DAY, due: priority / DAY >= lim, daysOver: Math.max(0, priority / DAY - lim) }));
    }
    sweepRetention() {
      const lim = this.settings.retentionDays;
      const sys = { name: "System", role: "system" };
      let flagged = 0, changed = false;
      for (const it of this.items.values()) {
        if (it.status !== S.UNCLAIMED) continue;
        const due = (this.now() - it.foundAt) / DAY >= lim;
        if (due && !it.flaggedAt) { it.flaggedAt = this.now(); flagged++; changed = true; this._log(sys, "RETENTION_FLAG", it.id, `Past ${lim}-day retention limit`); }
        else if (!due && it.flaggedAt) { it.flaggedAt = null; changed = true; }
      }
      if (changed) this._save();
      return flagged;
    }
    dueCount() { return this.retentionQueue(1e9).filter((r) => r.due).length; }
    archiveItem(token, id, disposition) {
      const s = this._need(token, "staff");
      const it = this.items.get(id);
      if (!it) throw new Error("Item not found.");
      const d = disposition === "donated" ? "donated" : "archived";
      it.disposition = d;
      this._transition(it, S.ARCHIVED, s, "archive", { disposition: d });
      this._log(s, d === "donated" ? "ITEM_DONATED" : "ITEM_ARCHIVED", it.id, d === "donated" ? "Donated after retention period" : "Archived after retention period");
      this._save();
      return this.staffItem(it);
    }
    processOldest(token, disposition) {
      this._need(token, "staff");
      const top = this._retentionHeap().pop();
      if (!top || top.priority / DAY < this.settings.retentionDays) throw new Error("Nothing is past the retention limit.");
      return this.archiveItem(token, top.item.id, disposition);
    }

    /* ===== rollbacks (Stack) ===== */
    undoPeek() {
      const id = this.undoStack.peek();
      if (!id) return null;
      const e = this._hist(id).peek();
      return e ? { itemId: id, type: e.type, from: e.from, to: e.to } : null;
    }
    undo(token) {
      const s = this._need(token, "staff");
      const id = this.undoStack.pop();
      if (!id) throw new Error("Nothing to undo.");
      const it = this.items.get(id);
      const e = this._hist(id).pop();
      const wasSearchable = this._searchable(it);
      it.status = e.from;
      if (e.type === "claim") { const c = this.claims.find((x) => x.id === e.claimId); if (c) c.status = "CANCELLED"; }
      if (e.type === "approve" || e.type === "rejectClaim") { const c = this.claims.find((x) => x.id === e.claimId); if (c) { c.status = "PENDING"; c.decidedAt = null; } it.claimedBy = null; it.claimedAt = null; }
      if (e.type === "archive") it.disposition = null;
      if (e.type === "receive") { this.codes.set(it.code, it.id); }
      if (e.type === "rejectPending") { this.codes.set(it.code, it.id); this.strikes.set(it.finderId, Math.max(0, (this.strikes.get(it.finderId) || 1) - 1)); }
      this._reindex(it, wasSearchable);
      this._log(s, "ROLLBACK", it.id, `Reverted ${LABEL[e.to]} → ${LABEL[e.from]} (${e.type})`);
      this._save();
      return this.staffItem(it);
    }
    itemHistory(id) { const st = this.history.get(id); return st ? st.toArray().reverse() : []; }
    auditLog({ itemId = "", action = "" } = {}) {
      return this.audit.filter((e) => (!itemId || e.itemId === itemId) && (!action || e.action === action)).slice().reverse();
    }

    /* ===== missing-item reports + smart matching ===== */
    _scoreTokens(x) { return new Set(cleanTokens([x.title, x.tags.join(" ")].join(" ")).filter((t) => !MATCH_STOP.has(t)).map(canon)); }
    matchScore(it, r) {
      const A = this._scoreTokens(it), B = this._scoreTokens(r);
      let inter = 0;
      for (const t of A) if (B.has(t)) inter++;
      const dice = A.size + B.size ? (2 * inter) / (A.size + B.size) : 0;
      const cat = it.category === r.category ? 1 : 0;
      const loc = it.gate === r.gate ? 1 : 0;
      const timeOk = r.lostAt <= it.foundAt + 2 * HOUR ? 1 : 0.3;
      return Math.min(1, (0.65 * dice + 0.25 * cat + 0.1 * loc) * timeOk);
    }
    _addAlert(r, it, score, actor) {
      const key = r.id + "|" + it.id;
      if (this.alertKeys.has(key)) return null;
      const a = { id: "A-" + String(++this.seq.alert).padStart(4, "0"), reportId: r.id, itemId: it.id, score, at: this.now(), seen: false };
      this.alerts.push(a); this.alertKeys.set(key, a.id);
      this._log(actor, "MATCH_ALERT", it.id, `Possible match with report ${r.id} (${Math.round(score * 100)}%)`);
      return a;
    }
    _matchItemAgainstReports(it, actor) {
      const cand = new Set();
      for (const w of it._idx || []) for (const id of this.reportTrie.searchPrefix(w)) cand.add(id);
      const out = [];
      for (const id of cand) {
        const r = this.reports.find((x) => x.id === id);
        if (!r || r.status !== "OPEN") continue;
        const sc = this.matchScore(it, r);
        if (sc >= MATCH_THRESHOLD) { const a = this._addAlert(r, it, sc, { name: "System (smart match)", role: "system" }); if (a) out.push(a); }
      }
      return out;
    }
    createReport(token, data) {
      const s = this._need(token, "student");
      const title = String(data.title || "").trim();
      if (title.length < 3 || title.length > 60) throw new Error("Give the missing item a short title (3–60 characters).");
      const description = String(data.description || "").trim().slice(0, 300);
      if (this._looksSpammy(title) || this._looksSpammy(description)) throw new Error("That entry looks like spam. Please describe the item plainly.");
      if (!this.categories.has(data.category)) throw new Error("Choose a category.");
      if (!this.gates.has(data.gate)) throw new Error("Choose where you last had it.");
      const lostAt = Number(data.lostAt) || this.now();
      if (lostAt > this.now() + 5 * MIN) throw new Error("The time lost can't be in the future.");
      const tags = [...new Set(String(data.tags || "").split(/[,;\n]/).map((x) => normalize(x)).filter(Boolean))].slice(0, 8);
      const r = { id: "R-" + String(++this.seq.report).padStart(4, "0"), ownerId: s.studentId, ownerName: s.name, contact: String(data.contact || "").trim().slice(0, 80), title, description, category: data.category, gate: data.gate, tags, lostAt, status: "OPEN", createdAt: this.now() };
      this.reports.push(r);
      this._indexReport(r);
      this._log(s, "REPORT_FILED", null, `Missing: ${r.title} (${r.id})`);
      const matches = [];
      for (const it of this.items.values()) {
        if (!this._searchable(it)) continue;
        const sc = this.matchScore(it, r);
        if (sc >= MATCH_THRESHOLD) { this._addAlert(r, it, sc, s); matches.push({ item: this.publicItem(it), score: sc }); }
      }
      this._save();
      return { report: r, matches: mergeSort(matches, (a, b) => b.score - a.score) };
    }
    closeReport(token, id) {
      const s = this._need(token, "student");
      const r = this.reports.find((x) => x.id === id && x.ownerId === s.studentId);
      if (!r) throw new Error("Report not found.");
      r.status = "CLOSED"; this._unindexReport(r);
      this._log(s, "REPORT_CLOSED", null, r.id);
      this._save();
    }
    myReports(token) {
      const s = this._need(token, "student");
      return this.reports.filter((r) => r.ownerId === s.studentId).slice().reverse().map((r) => ({
        report: r,
        alerts: mergeSort(this.alerts.filter((a) => a.reportId === r.id), (a, b) => b.score - a.score).map((a) => ({ alert: a, item: this.publicItem(this.items.get(a.itemId)) })),
      }));
    }
    unseenAlerts(token) {
      const s = this.session(token);
      if (!s) return 0;
      const mine = new Set(this.reports.filter((r) => r.ownerId === s.studentId).map((r) => r.id));
      return this.alerts.filter((a) => mine.has(a.reportId) && !a.seen).length;
    }
    markAlertsSeen(token) {
      const s = this.session(token);
      if (!s) return;
      const mine = new Set(this.reports.filter((r) => r.ownerId === s.studentId).map((r) => r.id));
      this.alerts.forEach((a) => { if (mine.has(a.reportId)) a.seen = true; });
      this._save();
    }
    myClaims(token) {
      const s = this._need(token, "student");
      return this.claims.filter((c) => c.claimantId === s.studentId).slice().reverse().map((c) => ({ claim: c, item: this.publicItem(this.items.get(c.itemId)) }));
    }
    myFinds(token) {
      const s = this._need(token, "student");
      return this.items.values().filter((it) => it.finderId === s.studentId && it.source === "self-service").sort((a, b) => b.createdAt - a.createdAt).map((it) => ({ ...this.publicItem(it), code: it.code }));
    }

    /* ===== stats ===== */
    stats() {
      const by = {};
      Object.keys(LABEL).forEach((k) => (by[k] = 0));
      for (const it of this.items.values()) by[it.status]++;
      return { byStatus: by, due: this.dueCount(), openClaims: this.claims.filter((c) => c.status === "PENDING").length, openReports: this.reports.filter((r) => r.status === "OPEN").length, alerts: this.alerts.length, total: this.items.size, hash: { size: this.items.size, longestChain: this.items.longestChain(), buckets: this.items.buckets.length }, trieWords: this.trie.wordCount };
    }

    /* ===== demo data (relative to "now") ===== */
    seedDemo() {
      const T = (days, hoursOffset = 0) => this.now() - days * DAY - hoursOffset * HOUR;
      const sys = this.login("staff", { name: "Front Desk", studentId: "STAFF-01", pin: STAFF_PIN });
      const add = (d, finderName, finderId) => {
        const f = this.login("student", { name: finderName, studentId: finderId });
        const r = this.createFoundItem(f.token, { ...d, tags: d.tags, foundAt: d.foundAt });
        this.logout(f.token);
        return r;
      };
      const staffAdd = (d) => this.createFoundItem(sys.token, d).item;
      staffAdd({ title: "Black umbrella", category: "umbrellas", gate: "g-lib", tags: "black, folding", description: "Compact folding umbrella left on a reading table.", foundAt: T(3, 1), secret: "wooden handle, initials MR written on the strap" });
      staffAdd({ title: "Black umbrella", category: "umbrellas", gate: "g-eng", tags: "black, long", description: "Long umbrella found beside the lockers.", foundAt: T(1, 3), secret: "one broken rib, red tape wrapped around the handle" });
      staffAdd({ title: "Blue Hydro Flask tumbler", category: "bottles", gate: "g-gym", tags: "blue, steel, 32oz", description: "Insulated tumbler found at the bleachers.", foundAt: T(5), secret: "dent near the bottom, Naruto sticker on the side" });
      const wallet = staffAdd({ title: "Black wallet", category: "wallets", gate: "g-main", tags: "black, leather", description: "Bifold wallet handed in by a student.", foundAt: T(2, 5), secret: "student ID of a BSIT student, 200 pesos folded, photo of a cat" });
      staffAdd({ title: "iPhone 13", category: "electronics", gate: "g-lib", tags: "midnight, cracked protector", description: "Phone found on a charging bench, screen locked.", foundAt: T(0, 6), secret: "lock screen photo of a dog, cracked screen protector top left" });
      staffAdd({ title: "Grey backpack", category: "bags", gate: "g-eng", tags: "grey, nike", description: "Backpack left in the engineering lobby.", foundAt: T(12), secret: "small penguin keychain, yellow notebook and a calculator inside" });
      staffAdd({ title: "Casio fx-991 calculator", category: "stationery", gate: "g-lib", tags: "scientific, black", description: "Scientific calculator found in a study room.", foundAt: T(35), secret: "initials JD scratched on the back" });
      staffAdd({ title: "Black-framed eyeglasses", category: "accessories", gate: "g-main", tags: "glasses, black frame", description: "Eyeglasses in a soft case.", foundAt: T(41), secret: "left lens has a small scratch, blue cleaning cloth in the case" });
      staffAdd({ title: "House keys with red lanyard", category: "keys", gate: "g-gym", tags: "red, lanyard", description: "Three keys on a red lanyard.", foundAt: T(52), secret: "tiny bell attached, one key has green rubber cap" });
      staffAdd({ title: "Student ID card", category: "ids", gate: "g-main", tags: "id, card", description: "Student ID card, name withheld for privacy.", foundAt: T(18), secret: "name on the card is Maria Santos" });
      staffAdd({ title: "AirPods case", category: "electronics", gate: "g-lib", tags: "white, earbuds", description: "White earbuds charging case.", foundAt: T(4), secret: "initials AB engraved on the lid" });
      staffAdd({ title: "Maroon hoodie", category: "clothing", gate: "g-gym", tags: "maroon, hoodie", description: "Pullover hoodie, size M.", foundAt: T(8), secret: "inside tag has the name Reyes in marker" });
      const rain = staffAdd({ title: "Orange raincoat", category: "clothing", gate: "g-main", tags: "orange, raincoat", description: "Light raincoat.", foundAt: T(70), secret: "" });
      this.archiveItem(sys.token, rain.id, "donated");
      add({ title: "White earbuds", category: "electronics", gate: "g-main", tags: "white, wireless", description: "Found near the guard post. Left with the guard.", foundAt: T(0, 2), secret: "tiny black scratch on the right bud" }, "Paolo Dizon", "24-00877");
      add({ title: "Green tote bag", category: "bags", gate: "g-lib", tags: "green, canvas", description: "Canvas tote with books inside.", foundAt: T(0, 20), secret: "a Hello Kitty keychain" }, "Lara Mendoza", "23-02210");
      add({ title: "Blue notebook", category: "stationery", gate: "g-eng", tags: "blue, notebook", description: "Spiral notebook.", foundAt: T(3), secret: "name Jose on the first page" }, "Ken Villar", "22-01977");
      const ana = this.login("student", { name: "Ana Reyes", studentId: "24-00123" });
      this.submitClaim(ana.token, wallet.id, "folded pesos, a photo of a cat, and my student id", "ana.reyes@school.edu");
      this.logout(ana.token);
      const jamie = this.login("student", { name: "Jamie Cruz", studentId: "24-01234" });
      this.createReport(jamie.token, { title: "Black umbrella with wooden handle", category: "umbrellas", gate: "g-lib", tags: "black, payong", description: "Lost it around the library after class.", lostAt: T(3, 3), contact: "jamie.cruz@school.edu" });
      this.logout(jamie.token);
      this.logout(sys.token);
      this.sweepRetention();
      this._save();
    }
  }

  return { Store, STATUS: S, LABEL, CATEGORIES, GATES, MATCH_THRESHOLD, CLAIM_PASS, DAY, HOUR, MIN, STAFF_PIN };
});
