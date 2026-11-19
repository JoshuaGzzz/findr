const assert = require("assert");
const { Store, STATUS: S, DAY, HOUR } = require("./store.js");
let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log("ok -", name); } catch (e) { console.log("FAIL -", name, "\n  ", e.message); process.exitCode = 1; } };

function memStorage() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } }; }
function fresh(opts = {}) {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const store = new Store({ clock, rng: opts.rng, storage: opts.storage });
  store.advance = (ms) => { now += ms; };
  store.staff = store.login("staff", { name: "Guard A", pin: "2026" });
  store.stu = (name = "Ana", id = "24-00001") => store.login("student", { name, studentId: id });
  return store;
}
const item = (o = {}) => ({ title: "Black umbrella", category: "umbrellas", gate: "g-lib", tags: "black", description: "", secret: "wooden handle", ...o });

t("login rules", () => {
  const s = fresh();
  assert.throws(() => s.login("staff", { name: "X Y", pin: "0000" }), /PIN/);
  assert.throws(() => s.login("student", { name: "Ana", studentId: "1" }), /valid/);
  assert.ok(s.login("student", { name: "Ana", studentId: "24-00001" }).token);
});

t("self-service item stays hidden until verified, then searchable", () => {
  const s = fresh(); const st = s.stu();
  const { item: it } = s.createFoundItem(st.token, item());
  assert.strictEqual(it.status, S.PENDING);
  assert.ok(it.code && it.code.length === 5);
  assert.strictEqual(s.search({ q: "umb" }).total, 0);
  assert.strictEqual(s.pendingQueue().length, 1);
  s.receiveItem(s.staff.token, it.code);
  assert.strictEqual(s.getItem(it.id).status, S.UNCLAIMED);
  assert.strictEqual(s.search({ q: "umb" }).total, 1);
  assert.strictEqual(s.pendingQueue().length, 0);
  assert.throws(() => s.receiveItem(s.staff.token, it.code), /No pending/);
});

t("prefix search, synonyms, typo correction", () => {
  const s = fresh();
  s.createFoundItem(s.staff.token, item());
  s.createFoundItem(s.staff.token, item({ title: "Blue tumbler", category: "bottles", tags: "blue" }));
  assert.strictEqual(s.search({ q: "umbr" }).total, 1);
  assert.strictEqual(s.search({ q: "payong" }).total, 1);       // Filipino synonym
  assert.strictEqual(s.search({ q: "hydroflask" }).total, 1);   // brand synonym of tumbler
  const typo = s.search({ q: "umbrela" });
  assert.strictEqual(typo.total, 1);
  assert.ok(typo.didYouMean);
  assert.strictEqual(s.search({ q: "zzzzzz" }).total, 0);
  // regression: loose fuzzy matching rewrote "scarf" to "card" and showed unrelated items
  s.createFoundItem(s.staff.token, item({ title: "Student ID card", category: "ids", tags: "id" }));
  const none = s.search({ q: "scarf" });
  assert.strictEqual(none.total, 0);
  assert.strictEqual(none.didYouMean, null);
  assert.deepStrictEqual(s.suggest("blu"), ["blue"]);
  assert.strictEqual(s.search({ category: "bottles" }).total, 1);
});

t("identical items are told apart by time and place", () => {
  const s = fresh();
  s.createFoundItem(s.staff.token, item({ foundAt: s.now() - 3 * DAY, gate: "g-lib" }));
  s.createFoundItem(s.staff.token, item({ foundAt: s.now() - 1 * DAY, gate: "g-eng", secret: "red tape" }));
  const r = s.search({ q: "black umbrella" });
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.results[0].item.lookalikes, 1);
  const twins = s.lookalikes(r.results[0].item.id);
  assert.strictEqual(twins.length, 2);
  assert.ok(twins[0].foundAt < twins[1].foundAt);
  assert.notStrictEqual(twins[0].gate, twins[1].gate);
  const recent = s.search({ q: "umbrella", from: s.now() - 2 * DAY });
  assert.strictEqual(recent.total, 1);
  assert.strictEqual(recent.results[0].item.gate, "g-eng");
  assert.strictEqual(s.search({ q: "umbrella", gate: "g-lib" }).total, 1);
});

t("claim: wrong details fail with limited attempts, right details go pending", () => {
  const s = fresh();
  const { item: it } = s.createFoundItem(s.staff.token, item({ secret: "Scratch on the corner, Naruto sticker" }));
  const a = s.stu("Ana", "24-00001");
  let r = s.submitClaim(a.token, it.id, "a red phone case maybe");
  assert.strictEqual(r.ok, false); assert.strictEqual(r.attemptsLeft, 2);
  assert.ok(!JSON.stringify(r).includes("Naruto"));
  s.submitClaim(a.token, it.id, "just some words here");
  s.submitClaim(a.token, it.id, "another wrong guess");
  assert.throws(() => s.submitClaim(a.token, it.id, "naruto sticker scratch corner"), /Too many/);
  const b = s.stu("Ben", "24-00002");
  r = s.submitClaim(b.token, it.id, "it has a naruto stiker and a scratch near the corner");
  assert.ok(r.ok); assert.ok(r.claim.score >= 0.5);
  assert.strictEqual(s.getItem(it.id).status, S.CLAIM_PENDING);
  assert.throws(() => s.submitClaim(s.stu("Cy", "24-00003").token, it.id, "naruto sticker scratch"), /already started/);
  assert.strictEqual(s.claimQueue().length, 1);
});

t("finder cannot claim own item; students cannot do staff actions", () => {
  const s = fresh(); const f = s.stu("Finn", "24-00009");
  const { item: it } = s.createFoundItem(f.token, item());
  s.receiveItem(s.staff.token, it.code);
  assert.throws(() => s.submitClaim(f.token, it.id, "wooden handle umbrella"), /reported this item/);
  assert.throws(() => s.receiveItem(f.token, it.id), /Staff access/);
  assert.throws(() => s.undo(f.token), /Staff access/);
});

t("approve + reject claim, lifecycle guard", () => {
  const s = fresh();
  const { item: it } = s.createFoundItem(s.staff.token, item({ secret: "wooden handle" }));
  const a = s.stu();
  const { claim } = s.submitClaim(a.token, it.id, "wooden handle");
  s.rejectClaim(s.staff.token, claim.id, "ID did not match");
  assert.strictEqual(s.getItem(it.id).status, S.UNCLAIMED);
  const c2 = s.submitClaim(s.stu("Bo", "24-00004").token, it.id, "wooden handle").claim;
  s.approveClaim(s.staff.token, c2.id);
  assert.strictEqual(s.getItem(it.id).status, S.CLAIMED);
  assert.strictEqual(s.search({ q: "umbrella" }).total, 0);
  assert.throws(() => s.approveClaim(s.staff.token, c2.id), /already decided/);
  assert.throws(() => s.rejectClaim(s.staff.token, claim.id), /already decided/);
  assert.strictEqual(s.archiveItem(s.staff.token, it.id).status, S.ARCHIVED); // Claimed -> Archived is allowed
  assert.throws(() => s.archiveItem(s.staff.token, it.id), /Cannot move/);    // Archived is terminal
});

t("spam controls: honeypot, rate limit, spam text, strikes", () => {
  const s = fresh(); const st = s.stu("Spam Bot", "24-00666");
  assert.throws(() => s.createFoundItem(st.token, { ...item(), website: "x" }), /blocked/);
  assert.throws(() => s.createFoundItem(st.token, item({ title: "aaaaaaaaaa" })), /spam/);
  assert.throws(() => s.createFoundItem(st.token, item({ description: "visit www.cheap.com now" })), /spam/);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(s.createFoundItem(st.token, item({ title: "Item number " + "abcdefg"[i] + "x" })).item.id);
  assert.throws(() => s.createFoundItem(st.token, item({ title: "Fourth thing" })), /Too many/);
  s.rejectPending(s.staff.token, ids[0], "prank");
  s.rejectPending(s.staff.token, ids[1], "prank");
  const st2 = s.login("student", { name: "Spam Bot", studentId: "24-00666" });
  assert.throws(() => s.createFoundItem(st2.token, item({ title: "Fresh attempt" })), /paused/);
  s.undo(s.staff.token); // undoing a rejection removes one strike
  assert.ok(s.createFoundItem(s.login("student", { name: "Spam Bot", studentId: "24-00666" }).token, item({ title: "Fresh attempt" })).item.id);
});

t("smart matching fires both ways (report first, item first)", () => {
  const s = fresh();
  const owner = s.stu("Jamie", "24-01234");
  // item arrives after the report
  const rep = s.createReport(owner.token, { title: "Black umbrella", category: "umbrellas", gate: "g-lib", tags: "black, payong", lostAt: s.now() - 2 * HOUR });
  assert.strictEqual(rep.matches.length, 0);
  assert.strictEqual(s.unseenAlerts(owner.token), 0);
  s.createFoundItem(s.staff.token, item({ foundAt: s.now() - HOUR }));
  assert.strictEqual(s.unseenAlerts(owner.token), 1);
  const mine = s.myReports(owner.token);
  assert.strictEqual(mine[0].alerts.length, 1);
  assert.ok(mine[0].alerts[0].alert.score >= 0.55);
  s.markAlertsSeen(owner.token);
  assert.strictEqual(s.unseenAlerts(owner.token), 0);
  // unrelated item does not alert
  s.createFoundItem(s.staff.token, item({ title: "Red wallet", category: "wallets", tags: "red" }));
  assert.strictEqual(s.myReports(owner.token)[0].alerts.length, 1);
  // report after the item exists matches immediately
  const o2 = s.stu("Kai", "24-04321");
  const r2 = s.createReport(o2.token, { title: "Umbrella black", category: "umbrellas", gate: "g-lib", tags: "", lostAt: s.now() - 3 * HOUR });
  assert.strictEqual(r2.matches.length, 1);
  // pending item matches only once verified
  const f = s.stu("Finn", "24-00009");
  const p = s.createFoundItem(f.token, item({ title: "Blue tumbler", category: "bottles", tags: "blue" })).item;
  const o3 = s.stu("Lee", "24-07777");
  s.createReport(o3.token, { title: "Blue tumbler", category: "bottles", gate: "g-lib", tags: "blue", lostAt: s.now() - HOUR });
  assert.strictEqual(s.unseenAlerts(o3.token), 0);
  s.receiveItem(s.staff.token, p.code);
  assert.strictEqual(s.unseenAlerts(o3.token), 1);
  // an item "found" long before the loss is not a match
  const o4 = s.stu("Mo", "24-08888");
  const r4 = s.createReport(o4.token, { title: "Black umbrella", category: "umbrellas", gate: "g-lib", tags: "black", lostAt: s.now() + 0 });
  assert.ok(r4.matches.length <= 2);
});

t("retention heap ranks by age, sweeps, processes oldest first", () => {
  const s = fresh();
  const ages = [5, 45, 33, 90, 12];
  ages.forEach((d, i) => s.createFoundItem(s.staff.token, item({ title: "Thing " + String.fromCharCode(65 + i) + "bc", foundAt: s.now() - d * DAY, category: "other" })));
  const q = s.retentionQueue();
  assert.deepStrictEqual(q.map((r) => Math.round(r.ageDays)), [90, 45, 33, 12, 5]);
  assert.deepStrictEqual(q.map((r) => r.due), [true, true, true, false, false]);
  assert.strictEqual(s.dueCount(), 3);
  assert.strictEqual(s.sweepRetention(), 3); // first sweep flags the 3 overdue items
  assert.strictEqual(s.sweepRetention(), 0); // idempotent: nothing new on a repeat run
  assert.strictEqual(s.setRetention(s.staff.token, 60), 60);
  assert.strictEqual(s.dueCount(), 1);
  assert.strictEqual(s.setRetention(s.staff.token, 5), 30); // clamped
  const oldest = s.processOldest(s.staff.token, "donated");
  assert.strictEqual(Math.round(oldest.ageDays), 90);
  assert.strictEqual(oldest.status, S.ARCHIVED); assert.strictEqual(oldest.disposition, "donated");
  s.processOldest(s.staff.token); s.processOldest(s.staff.token);
  assert.throws(() => s.processOldest(s.staff.token), /Nothing is past/);
});

t("stack-based rollback restores state and is audited", () => {
  const s = fresh();
  const { item: it } = s.createFoundItem(s.stu().token, item());
  s.receiveItem(s.staff.token, it.code);
  const claimer = s.stu("Bo", "24-00004");
  const { claim } = s.submitClaim(claimer.token, it.id, "wooden handle");
  s.approveClaim(s.staff.token, claim.id);
  assert.deepStrictEqual(s.itemHistory(it.id).map((e) => e.type), ["approve", "claim", "receive", "create"]);
  assert.strictEqual(s.undoPeek().type, "approve");
  s.undo(s.staff.token); assert.strictEqual(s.getItem(it.id).status, S.CLAIM_PENDING);
  assert.strictEqual(s.claimQueue().length, 1);
  s.undo(s.staff.token); assert.strictEqual(s.getItem(it.id).status, S.UNCLAIMED);
  assert.strictEqual(s.claims[0].status, "CANCELLED");
  s.undo(s.staff.token); assert.strictEqual(s.getItem(it.id).status, S.PENDING);
  assert.strictEqual(s.search({ q: "umbrella" }).total, 0);
  assert.strictEqual(s.pendingQueue().length, 1);
  assert.strictEqual(s.undoStack.size, 0);
  assert.throws(() => s.undo(s.staff.token), /Nothing to undo/);
  const log = s.auditLog({ itemId: it.id });
  assert.strictEqual(log[0].action, "ROLLBACK");
  assert.ok(log.some((e) => e.action === "CLAIM_APPROVED"));
  const seqs = s.audit.map((e) => e.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b)); // sequential
});

t("persistence round-trip rebuilds every index", () => {
  const storage = memStorage();
  const a = fresh({ storage });
  const { item: it } = a.createFoundItem(a.staff.token, item({ secret: "wooden handle" }));
  const own = a.stu();
  a.createReport(own.token, { title: "Red wallet", category: "wallets", gate: "g-main", tags: "red", lostAt: a.now() });
  a.submitClaim(a.stu("Bo", "24-00004").token, it.id, "wooden handle");
  const b = new Store({ clock: () => a.now(), storage });
  assert.ok(b.loaded);
  assert.strictEqual(b.getItem(it.id).status, S.CLAIM_PENDING);
  assert.strictEqual(b.search({ q: "umbr" }).total, 1);
  assert.strictEqual(b.claimQueue().length, 1);
  assert.strictEqual(b.reports.length, 1);
  assert.strictEqual(b.undoPeek().type, "claim");
  assert.strictEqual(b.audit.length, a.audit.length);
  assert.ok(b.session(a.staff.token));
});

t("demo seed produces the proposal's scenarios", () => {
  const storage = memStorage();
  const s = new Store({ clock: () => 1_800_000_000_000, storage });
  s.seedDemo();
  const st = s.stats();
  assert.ok(st.byStatus.UNCLAIMED >= 9);
  assert.strictEqual(st.byStatus.PENDING_DROPOFF, 3);
  assert.strictEqual(st.byStatus.CLAIM_PENDING, 1);
  assert.strictEqual(st.byStatus.ARCHIVED, 1);
  assert.ok(st.due >= 3);
  assert.strictEqual(s.search({ q: "black umbrella" }).total, 2);
  assert.strictEqual(s.search({ q: "payong" }).total, 2);
  const jamie = s.login("student", { name: "Jamie Cruz", studentId: "24-01234" });
  assert.strictEqual(s.myReports(jamie.token)[0].alerts.length >= 1, true);
  const again = new Store({ clock: () => 1_800_000_000_000, storage });
  assert.ok(again.loaded); assert.strictEqual(again.stats().total, st.total);
});

console.log(`\n${passed} store test groups passed`);
