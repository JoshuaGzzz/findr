/* FINDr remote store: the same interface as store.js, backed by Supabase.

   Reads: everything the signed-in user may see (Row Level Security decides) is loaded into the in-browser
   read model, so search, auto-complete, typo correction, lookalikes, the retention heap and the undo stack
   keep running on the DSA structures in dsa.js.
   Writes: every change goes through a server-side function (or an RLS-guarded insert) and the read model is
   reloaded afterwards. The private "secret detail" and claim matching never leave the database for students.

   Methods that change data are async. store.js methods are synchronous, so callers simply `await` both. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./store.js"));
  else root.FindrRemote = factory(root.FindrStore);
})(typeof self !== "undefined" ? self : this, function (FS) {
  "use strict";
  const { Store, STATUS: S, LABEL, CATEGORIES, GATES, MATCH_THRESHOLD } = FS;

  const BUCKET = "item-photos";
  const pad = (prefix, n) => prefix + "-" + String(n).padStart(4, "0");
  const dbId = (s) => Number(String(s).slice(2));
  const ms = (t) => (t ? new Date(t).getTime() : null);
  const up = (s) => String(s || "").toUpperCase();
  const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : "p" + Math.random().toString(36).slice(2) + Date.now().toString(36));

  class RemoteStore extends Store {
    /* client: a supabase-js client. opts.kv: { get(key), set(key, value) } for per-browser preferences. */
    constructor(client, opts = {}) {
      super({ clock: opts.clock, rng: opts.rng, storage: null });
      this.client = client;
      this.remote = true;
      this.loaded = true;
      this.profile = null;
      this.notice = null;
      this.kv = opts.kv || { get: () => null, set: () => {} };
      const saved = Number(this.kv.get("findr.retention"));
      if (saved >= 30 && saved <= 60) this.settings.retentionDays = saved;
    }

    /* ===== plumbing ===== */
    async _ok(promise) {
      const { data, error } = await promise;
      if (error) throw new Error(error.message || String(error));
      return data;
    }
    _rpc(name, args) { return this._ok(this.client.rpc(name, args)); }
    _seenKey() { return "findr.seen." + (this.profile ? this.profile.userId : "anon"); }

    /* ===== startup and auth ===== */
    async init() {
      await this._loadReferenceData();
      const { data } = await this.client.auth.getSession();
      await this._adopt(data && data.session);
      await this.refresh();
      return this;
    }
    async _loadReferenceData() {
      const [g, c] = await Promise.all([this.client.from("gates").select("id,name"), this.client.from("categories").select("id,label")]);
      // Mutated in place: the UI and the store both hold references to these arrays.
      if (g.data && g.data.length) { GATES.length = 0; g.data.forEach((r) => GATES.push([r.id, r.name])); }
      if (c.data && c.data.length) { CATEGORIES.length = 0; c.data.forEach((r) => CATEGORIES.push([r.id, r.label])); }
    }
    async _adopt(session) {
      if (!session || !session.user) { this.profile = null; return null; }
      const row = await this._ok(this.client.from("profiles").select("id,name,student_id,role,strikes").eq("id", session.user.id).maybeSingle());
      if (!row) throw new Error("Your account has no profile yet. Sign out and back in, or ask the administrator to run the latest migration.");
      this.profile = { token: "sb", userId: row.id, email: session.user.email, name: row.name, studentId: row.student_id, role: row.role === "staff" ? "staff" : "student", strikes: row.strikes || 0, submissions: [] };
      return this.profile;
    }
    async signIn({ email, password } = {}) {
      email = String(email || "").trim();
      if (!email || !password) throw new Error("Enter your email and password.");
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      await this._adopt(data.session);
      await this.refresh();
      return this.profile;
    }
    async signUp({ email, password, name, studentId } = {}) {
      email = String(email || "").trim(); name = String(name || "").trim(); studentId = String(studentId || "").trim();
      if (name.length < 2) throw new Error("Please enter your name.");
      if (!/^[A-Za-z0-9-]{4,16}$/.test(studentId)) throw new Error("Enter a valid student / employee ID (4–16 letters, digits or dashes).");
      if (!email) throw new Error("Enter your email.");
      if (String(password || "").length < 6) throw new Error("Use a password of at least 6 characters.");
      const { data, error } = await this.client.auth.signUp({ email, password, options: { data: { name, student_id: studentId } } });
      if (error) throw new Error(error.message);
      if (!data.session) return { needsConfirmation: true };
      await this._adopt(data.session);
      await this.refresh();
      return { profile: this.profile };
    }
    login() { throw new Error("Use signIn() or signUp() with a Supabase account."); }
    async logout() {
      await this.client.auth.signOut();
      this.profile = null;
      this.history = new (this.history.constructor)(64);
      while (this.undoStack.size) this.undoStack.pop();
      await this.refresh();
    }
    session(token) { return token && this.profile ? this.profile : null; }
    clearAll() {}
    seedDemo() { throw new Error("Demo data lives in supabase/seed_demo.sql for a Supabase backend."); }
    sweepRetention() { return 0; } // age is computed on the fly; nothing is written back to the database

    /* ===== load the read model ===== */
    async refresh() {
      const c = this.client, me = this.profile, staff = !!me && me.role === "staff";
      const [itemRows, profRows, repRows, claimRows, secretRows, auditRows] = await Promise.all([
        this._ok(c.from("items").select("*")),
        this._ok(c.from("profiles").select("id,name,student_id")),
        me ? this._ok(c.from("reports").select("*")) : [],
        me ? (staff ? this._ok(c.rpc("staff_claims")) : this._ok(c.from("claims").select("id,item_id,claimant_id,details,contact,status,created_at,decided_at"))) : [],
        staff ? this._ok(c.from("item_private").select("item_id,secret")) : [],
        staff ? this._ok(c.from("audit_log").select("*").order("seq", { ascending: false }).limit(500)) : [],
      ]);
      const photos = await this._signPhotos(itemRows);

      const keep = { history: this.history, undo: this.undoStack, settings: this.settings };
      this._reset();
      this.history = keep.history; this.undoStack = keep.undo; this.settings = keep.settings;

      const people = new Map(profRows.map((p) => [p.id, p]));
      const secrets = new Map(secretRows.map((r) => [r.item_id, r.secret]));
      for (const r of itemRows) {
        if (!this.categories.has(r.category) || !this.gates.has(r.gate)) continue;
        const fin = people.get(r.finder_id);
        this._ingestItem({
          id: pad("I", r.id), _db: r.id, title: r.title, category: r.category, gate: r.gate, tags: r.tags || [], description: r.description || "",
          foundAt: ms(r.found_at), status: up(r.status), photo: photos.get(r.photo_path) || null, secret: secrets.get(r.id) || "",
          finderName: fin ? fin.name : "", finderId: fin ? fin.student_id : r.finder_id, finderUid: r.finder_id, source: r.source,
          createdAt: ms(r.created_at), code: r.code || null, flaggedAt: ms(r.flagged_at), disposition: r.disposition || null,
        });
      }
      this.claims = claimRows.map((r) => (staff ? this._staffClaim(r) : this._ownClaim(r, me)));
      this.reports = repRows.map((r) => {
        const o = people.get(r.owner_id);
        return { id: pad("R", r.id), _db: r.id, ownerUid: r.owner_id, ownerId: o ? o.student_id : r.owner_id, ownerName: o ? o.name : "", contact: r.contact || "", title: r.title, description: r.description || "", category: r.category, gate: r.gate, tags: r.tags || [], lostAt: ms(r.lost_at), status: up(r.status), createdAt: ms(r.created_at) };
      });
      for (const r of this.reports) if (r.status === "OPEN") this._indexReport(r);
      this.audit = auditRows.slice().reverse().map((e) => ({ seq: e.seq, at: ms(e.at), actor: e.actor_name || "System", role: e.role || "", action: e.action, itemId: e.item_id ? pad("I", e.item_id) : null, detail: e.detail || "" }));
      this._deriveAlerts();
    }
    _staffClaim(r) {
      const score = r.claim_score == null ? null : Number(r.claim_score);
      return { id: pad("C", r.claim_id), _db: r.claim_id, itemId: pad("I", r.claim_item_id), claimantUid: r.claimant_uid, claimantId: r.claimant_student_id || "", claimantName: r.claimant_name || "", contact: r.claim_contact || "", details: r.claim_details, score, matched: r.claim_matched || [], missed: r.claim_missed || [], manual: score == null, at: ms(r.claim_created_at), status: up(r.claim_status), decidedAt: ms(r.claim_decided_at) };
    }
    _ownClaim(r, me) {
      return { id: pad("C", r.id), _db: r.id, itemId: pad("I", r.item_id), claimantUid: r.claimant_id, claimantId: me.studentId, claimantName: me.name, contact: r.contact || "", details: r.details, score: null, matched: [], missed: [], manual: false, at: ms(r.created_at), status: up(r.status), decidedAt: ms(r.decided_at) };
    }
    async _signPhotos(rows) {
      const map = new Map();
      const paths = [...new Set(rows.map((r) => r.photo_path).filter(Boolean))].slice(0, 300);
      if (!paths.length) return map;
      try {
        const { data } = await this.client.storage.from(BUCKET).createSignedUrls(paths, 3600);
        for (const d of data || []) if (d.signedUrl) map.set(d.path, d.signedUrl);
      } catch (e) { /* photos are optional; the tile fallback is shown */ }
      return map;
    }

    /* Smart-match alerts are derived in the browser with the same matcher as before (no alert rows are stored). */
    _deriveAlerts() {
      this.alerts = []; this.alertKeys = new (this.alertKeys.constructor)(32);
      if (!this.profile || this.profile.role === "staff") return;
      let seen = [];
      try { seen = JSON.parse(this.kv.get(this._seenKey()) || "[]"); } catch (e) { seen = []; }
      const seenSet = new Set(seen);
      for (const r of this.reports) {
        if (r.status !== "OPEN" || r.ownerUid !== this.profile.userId) continue;
        for (const it of this.items.values()) {
          if (!this._searchable(it) || it.finderUid === this.profile.userId) continue;
          const score = this.matchScore(it, r);
          if (score < MATCH_THRESHOLD) continue;
          const id = "A-" + r.id.slice(2) + "-" + it.id.slice(2);
          this.alerts.push({ id, reportId: r.id, itemId: it.id, score, at: this.now(), seen: seenSet.has(id) });
          this.alertKeys.set(r.id + "|" + it.id, id);
        }
      }
    }
    _openReportMatches(it) { return this.reports.filter((r) => r.status === "OPEN" && this._searchable(it) && this.matchScore(it, r) >= MATCH_THRESHOLD).length; }
    unseenAlerts(token) { return this.session(token) ? this.alerts.filter((a) => !a.seen).length : 0; }
    markAlertsSeen(token) {
      if (!this.session(token)) return;
      this.alerts.forEach((a) => { a.seen = true; });
      try { this.kv.set(this._seenKey(), JSON.stringify(this.alerts.map((a) => a.id))); } catch (e) { /* storage unavailable */ }
    }

    /* ===== intake ===== */
    async _upload(dataUrl, uid) {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        const path = uid + "/" + uuid() + ".jpg";
        const { error } = await this.client.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
        if (error) throw error;
        return path;
      } catch (e) {
        this.notice = "The photo could not be uploaded, so the item was saved without it.";
        return null;
      }
    }
    async createFoundItem(token, data) {
      const s = this._need(token);
      const staff = s.role === "staff";
      if (!staff && data.website) throw new Error("Submission blocked.");
      const f = this._fields(data, staff); // same validation and spam filter as the local store; the server enforces limits again
      const photoPath = data.photo ? await this._upload(data.photo, s.userId) : null;
      const row = await this._rpc("create_found_item", {
        p_title: f.title, p_category: f.category, p_gate: f.gate, p_tags: f.tags, p_description: f.description,
        p_found_at: new Date(f.foundAt).toISOString(), p_secret: String(data.secret || "").trim().slice(0, 300) || null, p_photo_path: photoPath,
      });
      await this.refresh();
      const it = this.items.get(pad("I", row.id));
      return { item: this.staffItem(it), alerts: staff ? this._openReportMatches(it) : 0 };
    }

    /* ===== staff: drop-offs ===== */
    async receiveItem(token, idOrCode, secret) {
      const s = this._need(token, "staff");
      const key = String(idOrCode || "").trim().toUpperCase();
      const known = this.items.get(this.codes.get(key) || idOrCode);
      if (known && known.status !== S.PENDING) throw new Error(`${known.id} is already ${LABEL[known.status]}.`);
      const code = known ? known.code : key;
      const row = await this._rpc("receive_item", { p_code: code, p_secret: secret != null && String(secret).trim() ? String(secret).trim().slice(0, 300) : null });
      const id = pad("I", row.id);
      this._hist(id).push({ type: "receive", from: S.PENDING, to: S.UNCLAIMED, at: this.now(), actor: s.name, code });
      this.undoStack.push(id);
      await this.refresh();
      const it = this.items.get(id);
      return { item: this.staffItem(it), alerts: this._openReportMatches(it) };
    }
    async rejectPending(token, id, reason) {
      const s = this._need(token, "staff");
      const it = this.items.get(id);
      if (!it || it.status !== S.PENDING) throw new Error("Only pending items can be rejected.");
      await this._rpc("reject_pending", { p_item: it._db, p_reason: reason || "spam / never dropped off" });
      this._hist(id).push({ type: "rejectPending", from: S.PENDING, to: S.ARCHIVED, at: this.now(), actor: s.name, reason: reason || "spam" });
      this.undoStack.push(id);
      await this.refresh();
      return this.staffItem(this.items.get(id));
    }

    /* ===== claims ===== */
    async submitClaim(token, itemId, details, contact) {
      this._need(token, "student");
      const it = this.items.get(itemId);
      if (!it) throw new Error("Item not found.");
      if (it.status !== S.UNCLAIMED) throw new Error(it.status === S.CLAIM_PENDING ? "Someone has already started a claim on this item. Visit the security office if it's yours." : "This item can't be claimed right now.");
      const r = await this._rpc("submit_claim", { p_item: it._db, p_details: String(details || "").trim(), p_contact: String(contact || "").trim().slice(0, 80) || null });
      if (!r || !r.ok) return { ok: false, attemptsLeft: r ? r.attemptsLeft : 0, message: "Those details don't match what security has on file. Think about marks, stickers, contents or the lock screen, and try again." };
      await this.refresh();
      return { ok: true, claim: this.claims.find((c) => c._db === r.claimId) || null };
    }
    async _decide(token, claimId, approve) {
      const s = this._need(token, "staff");
      const c = this.claims.find((x) => x.id === claimId && x.status === "PENDING");
      if (!c) throw new Error("Claim not found or already decided.");
      await this._rpc("decide_claim", { p_claim: c._db, p_approve: approve });
      this._hist(c.itemId).push({ type: approve ? "approve" : "rejectClaim", from: S.CLAIM_PENDING, to: approve ? S.CLAIMED : S.UNCLAIMED, at: this.now(), actor: s.name, claimId });
      this.undoStack.push(c.itemId);
      await this.refresh();
      return this.staffItem(this.items.get(c.itemId));
    }
    approveClaim(token, claimId) { return this._decide(token, claimId, true); }
    rejectClaim(token, claimId) { return this._decide(token, claimId, false); }

    /* ===== retention and rollback ===== */
    setRetention(token, days) {
      this._need(token, "staff");
      const d = Math.max(30, Math.min(60, Math.round(Number(days) || 30)));
      this.settings.retentionDays = d;
      try { this.kv.set("findr.retention", String(d)); } catch (e) { /* storage unavailable */ }
      return d;
    }
    async archiveItem(token, id, disposition) {
      const s = this._need(token, "staff");
      const it = this.items.get(id);
      if (!it) throw new Error("Item not found.");
      if (![S.UNCLAIMED, S.CLAIMED, S.PENDING].includes(it.status)) throw new Error(`Cannot move an item from ${LABEL[it.status]} to ${LABEL[S.ARCHIVED]}.`);
      const d = disposition === "donated" ? "donated" : "archived";
      const from = it.status;
      await this._rpc("archive_item", { p_item: it._db, p_disposition: d });
      this._hist(id).push({ type: "archive", from, to: S.ARCHIVED, at: this.now(), actor: s.name, disposition: d });
      this.undoStack.push(id);
      await this.refresh();
      return this.staffItem(this.items.get(id));
    }
    async undo(token) {
      this._need(token, "staff");
      const id = this.undoStack.peek();
      if (!id) throw new Error("Nothing to undo.");
      const e = this._hist(id).peek();
      const args = { p_item: dbId(id), p_kind: e.type };
      if (e.claimId) args.p_claim = dbId(e.claimId);
      if (e.type === "archive") args.p_to = String(e.from).toLowerCase();
      if (e.type === "receive") args.p_code = e.code;
      await this._rpc("staff_rollback", args); // throws (and keeps the stack) if the item has moved on since
      this.undoStack.pop();
      this._hist(id).pop();
      await this.refresh();
      return this.staffItem(this.items.get(id));
    }

    /* ===== reports ===== */
    async createReport(token, data) {
      const s = this._need(token, "student");
      const title = String(data.title || "").trim();
      if (title.length < 3 || title.length > 60) throw new Error("Give the missing item a short title (3–60 characters).");
      const description = String(data.description || "").trim().slice(0, 300);
      if (this._looksSpammy(title) || this._looksSpammy(description)) throw new Error("That entry looks like spam. Please describe the item plainly.");
      if (!this.categories.has(data.category)) throw new Error("Choose a category.");
      if (!this.gates.has(data.gate)) throw new Error("Choose where you last had it.");
      const lostAt = Number(data.lostAt) || this.now();
      if (lostAt > this.now() + 5 * FS.MIN) throw new Error("The time lost can't be in the future.");
      const tags = [...new Set(String(data.tags || "").split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
      const row = await this._ok(this.client.from("reports").insert({
        owner_id: s.userId, title, category: data.category, gate: data.gate, tags, description,
        contact: String(data.contact || "").trim().slice(0, 80) || null, lost_at: new Date(lostAt).toISOString(),
      }).select("id").single());
      await this.refresh();
      const report = this.reports.find((r) => r._db === row.id);
      const matches = this.items.values().filter((it) => this._searchable(it) && this.matchScore(it, report) >= MATCH_THRESHOLD)
        .map((it) => ({ item: this.publicItem(it), score: this.matchScore(it, report) })).sort((a, b) => b.score - a.score);
      return { report, matches };
    }
    async closeReport(token, id) {
      const s = this._need(token, "student");
      const r = this.reports.find((x) => x.id === id && x.ownerUid === s.userId);
      if (!r) throw new Error("Report not found.");
      await this._ok(this.client.from("reports").update({ status: "closed" }).eq("id", r._db));
      await this.refresh();
    }
    myReports(token) {
      const s = this._need(token, "student");
      return this.reports.filter((r) => r.ownerUid === s.userId).slice().reverse().map((r) => ({
        report: r,
        alerts: this.alerts.filter((a) => a.reportId === r.id).sort((a, b) => b.score - a.score).map((a) => ({ alert: a, item: this.publicItem(this.items.get(a.itemId)) })),
      }));
    }
    myClaims(token) {
      const s = this._need(token, "student");
      return this.claims.filter((c) => c.claimantUid === s.userId && this.items.has(c.itemId)).slice().reverse().map((c) => ({ claim: c, item: this.publicItem(this.items.get(c.itemId)) }));
    }
    myFinds(token) {
      const s = this._need(token, "student");
      return this.items.values().filter((it) => it.finderUid === s.userId && it.source === "self-service").sort((a, b) => b.createdAt - a.createdAt).map((it) => ({ ...this.publicItem(it), code: it.code }));
    }
  }

  /* Build a store from { url, key }. createClient comes from the supabase-js bundle (global `supabase`). */
  function create(config, deps = {}) {
    const createClient = deps.createClient || (globalThis.supabase && globalThis.supabase.createClient);
    if (!createClient) throw new Error("The Supabase client library is not loaded.");
    const client = createClient(config.url, config.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    return new RemoteStore(client, deps);
  }

  return { RemoteStore, create };
});
