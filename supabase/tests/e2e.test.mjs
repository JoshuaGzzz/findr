// End-to-end: the real RemoteStore adapter (supabase.js) running against a real Postgres engine (PGlite)
// that has the reconstructed 0001 schema + migration 0002 applied, through a tiny PostgREST-style client.
// Usage: node supabase/tests/e2e.test.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(join(here, p), "utf8");
const FS = require("../../store.js");
const { RemoteStore } = require("../../supabase.js");

const db = new PGlite();
await db.exec(read("base_0001_reconstructed.sql"));
await db.exec(read("../migrations/0002_hardening_and_rpc.sql"));
for (const [id, label] of FS.CATEGORIES) await db.query("insert into categories values ($1,$2)", [id, label]);
for (const [id, name] of FS.GATES) await db.query("insert into gates values ($1,$2)", [id, name]);
const CATS = FS.CATEGORIES.map((c) => c.slice()), GATE_LIST = FS.GATES.map((g) => g.slice());

/* ---------- a minimal PostgREST/GoTrue/Storage stand-in over PGlite ---------- */
let lock = Promise.resolve();
const serial = (fn) => { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run; };
const passwords = new Map();

function makeClient() {
  const state = { user: null };
  const run = (sql, params) => serial(async () => {
    await db.exec(state.user ? `set role authenticated; select set_config('request.jwt.claim.sub','${state.user.id}',false);` : `set role anon; select set_config('request.jwt.claim.sub','',false);`);
    try { return JSON.parse(JSON.stringify((await db.query(sql, params)).rows)); } finally { await db.exec("reset role;"); }
  });
  const result = async (p) => { try { return { data: await p, error: null }; } catch (e) { return { data: null, error: { message: String(e.message || e) } }; } };

  function table(name) {
    const q = { mode: "select", cols: "*", where: [], order: null, lim: null, row: null, single: null, returning: null };
    const b = {
      select(cols = "*") { if (q.mode === "insert") q.returning = cols; else q.cols = cols; return b; },
      insert(row) { q.mode = "insert"; q.row = row; return b; },
      update(row) { q.mode = "update"; q.row = row; return b; },
      eq(c, v) { q.where.push([c, v]); return b; },
      order(c, o = {}) { q.order = [c, o.ascending === false ? "desc" : "asc"]; return b; },
      limit(n) { q.lim = n; return b; },
      maybeSingle() { q.single = "maybe"; return b; },
      single() { q.single = "one"; return b; },
      then(res, rej) { return exec().then(res, rej); },
    };
    const exec = () => result((async () => {
      const params = []; const P = (v) => { params.push(v); return "$" + params.length; };
      let sql;
      if (q.mode === "select") {
        sql = `select ${q.cols} from public.${name}`;
      } else if (q.mode === "insert") {
        const keys = Object.keys(q.row);
        sql = `insert into public.${name} (${keys.join(",")}) values (${keys.map((k) => P(q.row[k])).join(",")}) returning ${q.returning || "id"}`;
      } else {
        const keys = Object.keys(q.row);
        sql = `update public.${name} set ${keys.map((k) => `${k} = ${P(q.row[k])}`).join(",")}`;
      }
      if (q.mode !== "insert" && q.where.length) sql += " where " + q.where.map(([c, v]) => `${c} = ${P(v)}`).join(" and ");
      if (q.order) sql += ` order by ${q.order[0]} ${q.order[1]}`;
      if (q.lim) sql += ` limit ${q.lim}`;
      const rows = await run(sql, params);
      if (q.single === "maybe") return rows[0] || null;
      if (q.single === "one") { if (!rows.length) throw new Error("no rows"); return rows[0]; }
      return q.mode === "update" ? null : rows;
    })());
    return b;
  }

  const SETOF = new Set(["staff_claims"]);
  const client = {
    from: table,
    rpc(name, args = {}) {
      const keys = Object.keys(args); const params = keys.map((k) => args[k]);
      const call = `${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")})`;
      return result((async () => {
        const rows = await run(`select * from public.${call}`, params);
        if (SETOF.has(name)) return rows;
        const r = rows[0] || {}; const ks = Object.keys(r);
        if (ks.length === 1) return r[ks[0]] === "" ? null : r[ks[0]];
        return r;
      })());
    },
    auth: {
      async getSession() { return { data: { session: state.user ? { user: state.user } : null } }; },
      async signUp({ email, password, options }) {
        if (passwords.has(email)) return { data: {}, error: { message: "User already registered" } };
        const id = (await serial(async () => (await db.query("insert into auth.users (email, raw_user_meta_data) values ($1,$2) returning id", [email, JSON.stringify(options.data)])).rows[0].id));
        passwords.set(email, password); state.user = { id, email };
        return { data: { session: { user: state.user } }, error: null };
      },
      async signInWithPassword({ email, password }) {
        if (passwords.get(email) !== password) return { data: {}, error: { message: "Invalid login credentials" } };
        const id = (await serial(async () => (await db.query("select id from auth.users where email = $1", [email])).rows[0].id));
        state.user = { id, email };
        return { data: { session: { user: state.user } }, error: null };
      },
      async signOut() { state.user = null; return { error: null }; },
    },
    storage: {
      from: (bucket) => ({
        async createSignedUrls(paths) { return { data: paths.map((p) => ({ path: p, signedUrl: "https://signed.example/" + p })) }; },
        async upload(path) {
          try { await run("insert into storage.objects (bucket_id, name) values ($1,$2)", [bucket, path]); return { data: { path }, error: null }; }
          catch (e) { return { data: null, error: { message: e.message } }; }
        },
      }),
    },
  };
  return client;
}

const mem = new Map();
const kv = { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v) };
const newStore = () => new RemoteStore(makeClient(), { kv });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? "  [" + JSON.stringify(extra).slice(0, 300) + "]" : "")); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

/* ---------- 1. anonymous visitor ---------- */
const anon = await newStore().init();
ok("init loads gates and categories from the database", FS.GATES.length === GATE_LIST.length && FS.CATEGORIES.length === CATS.length);
ok("anonymous visitor has no session", anon.session("sb") === null && anon.search({}).total === 0);

/* ---------- 2. student Alice turns in an umbrella ---------- */
const alice = await newStore().init();
const su = await alice.signUp({ email: "alice@x.com", password: "secret1", name: "Alice Finder", studentId: "24-00001" });
ok("sign-up creates a student profile", su.profile && su.profile.role === "student" && su.profile.name === "Alice Finder" && su.profile.studentId === "24-00001", su);
const dup = await threw(() => alice.signUp({ email: "alice@x.com", password: "secret1", name: "Alice Finder", studentId: "24-00001" }));
ok("duplicate sign-up is refused", /already registered/.test(dup || ""), dup);
ok("sign-up validates the student ID", /valid student/.test(await threw(() => alice.signUp({ email: "z@x.com", password: "secret1", name: "Zed Zed", studentId: "!" })) || ""));
const photo = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const made = await alice.createFoundItem("sb", { title: "Black umbrella", category: "umbrellas", gate: "g-lib", tags: "black, payong", description: "Left on a table", foundAt: Date.now() - 3600e3, secret: "wooden handle, initials MR on the strap", photo });
ok("student intake returns a drop-off code and a pending item", /^[A-Z2-9]{5}$/.test(made.item.code) && made.item.status === "PENDING_DROPOFF", made.item);
const code = made.item.code;
ok("pending item is not searchable yet", alice.search({ q: "umbrella" }).total === 0);
ok("finder sees it under 'Items I turned in' with the code", alice.myFinds("sb").length === 1 && alice.myFinds("sb")[0].code === code);
ok("photo was uploaded and a signed URL is attached", !!alice.items.get(made.item.id).photo && /signed\.example/.test(alice.items.get(made.item.id).photo), alice.items.get(made.item.id).photo);
ok("the finder's own view never includes the private detail", alice.items.get(made.item.id).secret === "");
ok("student cannot use staff actions", /Staff access only/.test(await threw(() => alice.receiveItem("sb", code)) || ""));

/* ---------- 3. staff confirm the drop-off ---------- */
const staff = await newStore().init();
await staff.signUp({ email: "desk@x.com", password: "secret1", name: "Front Desk", studentId: "STAFF-01" });
await db.exec("update profiles set role = 'staff' where student_id = 'STAFF-01'"); // staff are promoted by the administrator in SQL
await staff.signIn({ email: "desk@x.com", password: "secret1" });
ok("promoted account signs in as staff", staff.profile.role === "staff");
const pq = staff.pendingQueue();
ok("staff see the pending item with finder name and code", pq.length === 1 && pq[0].finderName === "Alice Finder" && pq[0].code === code && pq[0].secret.includes("wooden"), pq[0]);
const rec = await staff.receiveItem("sb", code);
ok("typing the code marks it received", rec.item.status === "UNCLAIMED" && staff.search({ q: "umbrella" }).total === 1);
const upd = await staff.undo("sb");
ok("undo restores pending with the same drop-off code", upd.status === "PENDING_DROPOFF" && upd.code === code, upd);
const rec2 = await staff.receiveItem("sb", staff.pendingQueue()[0].id); // by item id, as the 'Received' button does
ok("receiving by item id works too", rec2.item.status === "UNCLAIMED");
ok("staff can read the private detail", staff.items.get(rec2.item.id).secret.includes("wooden"));
ok("undo stack holds the one change still reversible (receive, undo, receive)", staff.undoStack.size === 1, staff.undoStack.size);

/* ---------- 4. public search and typo / synonym handling ---------- */
const visitor = await newStore().init();
ok("anonymous search finds it by Filipino synonym", visitor.search({ q: "payong" }).total === 1);
ok("typo correction works against server data", visitor.search({ q: "umbrela" }).didYouMean === "umbrella", visitor.search({ q: "umbrela" }).didYouMean);
ok("auto-complete from the trie", visitor.suggest("umb").includes("umbrella"));
const pub = visitor.search({ q: "umbrella" }).results[0].item;
ok("the public item has no secret field", !("secret" in pub) && !("code" in pub), Object.keys(pub));
ok("raw rows seen by anonymous visitors hold no secret", visitor.items.values().every((i) => !i.secret));

/* ---------- 5. student Bob: report, alert, claim ---------- */
const bob = await newStore().init();
await bob.signUp({ email: "bob@x.com", password: "secret1", name: "Bob Owner", studentId: "24-00002" });
const rep = await bob.createReport("sb", { title: "Black umbrella with wooden handle", category: "umbrellas", gate: "g-lib", tags: "black, payong", description: "Lost near the library", lostAt: Date.now() - 4 * 3600e3, contact: "bob@x.com" });
ok("filing a report returns matching items right away", rep.matches.length === 1 && rep.matches[0].score >= FS.MATCH_THRESHOLD, rep.matches.length);
ok("smart-match alert badge shows 1 unseen", bob.unseenAlerts("sb") === 1);
bob.markAlertsSeen("sb");
ok("viewing activity clears the badge", bob.unseenAlerts("sb") === 0);
await bob.refresh();
ok("seen state survives a reload", bob.unseenAlerts("sb") === 0 && bob.myReports("sb")[0].alerts.length === 1);
const itemId = rec2.item.id;
const w1 = await bob.submitClaim("sb", itemId, "a green backpack with books", "bob@x.com");
ok("wrong claim → ok:false, 2 tries left, no secret in the reply", w1.ok === false && w1.attemptsLeft === 2 && !JSON.stringify(w1).includes("wooden"), w1);
const good = await bob.submitClaim("sb", itemId, "wooden handle, initials MR on the strap", "bob@x.com");
ok("matching claim is accepted", good.ok === true && good.claim && good.claim.status === "PENDING", good);
ok("claimant's own claim carries no matcher output", good.claim.matched.length === 0 && good.claim.missed.length === 0 && good.claim.score === null);
ok("item shows Claim Pending in search", bob.items.get(itemId).status === "CLAIM_PENDING");
ok("student cannot reach staff-only claim review data", bob.claimQueue().every((x) => x.claim.matched.length === 0));

/* ---------- 6. staff review, approve, undo ---------- */
await staff.refresh();
const cq = staff.claimQueue();
ok("staff see the claim with score, matched words and the secret", cq.length === 1 && cq[0].claim.score >= 0.5 && cq[0].claim.matched.length > 0 && cq[0].item.secret.includes("wooden") && cq[0].claim.claimantName === "Bob Owner", cq[0]);
const appr = await staff.approveClaim("sb", cq[0].claim.id);
ok("approving releases the item", appr.status === "CLAIMED");
await bob.refresh();
const mc = bob.myClaims("sb");
ok("claimant still sees the approved claim and its item", mc.length === 1 && mc[0].claim.status === "APPROVED" && mc[0].item.title === "Black umbrella", mc[0] && mc[0].claim);
const un = await staff.undo("sb");
ok("undo of an approval puts the claim back under review", un.status === "CLAIM_PENDING" && staff.claimQueue().length === 1);
const rj = await staff.rejectClaim("sb", staff.claimQueue()[0].claim.id);
ok("rejecting returns the item to Unclaimed", rj.status === "UNCLAIMED");
ok("student undo is blocked", /Staff access only/.test(await threw(() => bob.undo("sb")) || ""));

/* ---------- 7. retention, archive, rollback, audit ---------- */
const arch = await staff.archiveItem("sb", itemId, "donated");
ok("archive stores the disposition", arch.status === "ARCHIVED" && arch.disposition === "donated", arch);
const back = await staff.undo("sb");
ok("undo of an archive restores the previous status", back.status === "UNCLAIMED" && back.disposition === null, back);
ok("retention slider is remembered per browser", staff.setRetention("sb", 45) === 45 && kv.get("findr.retention") === "45");
const audit = staff.auditLog().map((e) => e.action);
ok("audit log shows the whole story to staff", ["ITEM_LOGGED", "ITEM_VERIFIED", "CLAIM_FAILED", "CLAIM_SUBMITTED", "CLAIM_APPROVED", "CLAIM_REJECTED", "ITEM_DONATED", "ROLLBACK"].every((a) => audit.includes(a)), audit);
ok("audit log is empty for students", bob.auditLog().length === 0);
ok("stats come from the DSA structures over server data", staff.stats().total === 1 && staff.stats().trieWords > 3);

/* ---------- 8. limits are enforced by the server ---------- */
const mk = (t) => alice.createFoundItem("sb", { title: t, category: "bags", gate: "g-main", tags: "", description: "", foundAt: Date.now() - 60e3, secret: "" });
await mk("Grey backpack"); await mk("Green tote");
const third = await threw(() => mk("Blue tumbler"));
ok("the 4th self-service report in 10 minutes is refused by the database", /Too many reports/.test(third || ""), third);
ok("honeypot field blocks bots before any request", /blocked/.test(await threw(() => alice.createFoundItem("sb", { title: "Bot item", category: "bags", gate: "g-main", website: "http://spam.example" })) || ""));
ok("spam text is blocked client-side", /spam/.test(await threw(() => bob.createReport("sb", { title: "aaaaaaaaaa", category: "bags", gate: "g-main" })) || ""));

/* ---------- 9. sign-out and session errors ---------- */
await bob.logout();
ok("sign-out clears the session and any private view", bob.session("sb") === null && bob.claims.length === 0);
ok("wrong password is rejected", /Invalid login/.test(await threw(() => bob.signIn({ email: "bob@x.com", password: "nope" })) || ""));
ok("signed-out visitors still search", bob.search({ q: "umbrella" }).total === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
