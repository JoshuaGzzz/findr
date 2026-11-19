// Runs the SQL migrations on a real Postgres engine (PGlite, Postgres compiled to WASM).
// Usage: node supabase/tests/migration.test.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");
const db = new PGlite();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? "  [" + JSON.stringify(extra) + "]" : "")); } };

/* Act as a Supabase role: "anon", or "authenticated" with a user id. */
async function as(role, uid, fn) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid || ""}', false);`);
  try { return await fn(); } finally { await db.exec("reset role;"); }
}
const q = (sql, params) => db.query(sql, params).then((r) => r.rows);
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e); } };

/* ---------- fixture ---------- */
await db.exec(read("base_0001_reconstructed.sql"));
await db.exec(`insert into categories values ('umbrellas','Umbrellas'),('wallets','Wallets & Cards'),('bags','Bags');
  insert into gates values ('g-main','Main Gate'),('g-lib','Library Entrance');`);

// BEFORE 0002: reproduce the bugs that were found by reading the live definitions.
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa','x@x.com');
  insert into profiles (id, name, student_id) values ('00000000-0000-0000-0000-0000000000aa','Pre','00-0000');
  insert into items (title, category, gate, status, finder_id, source) values ('Old umbrella','umbrellas','g-main','unclaimed','00000000-0000-0000-0000-0000000000aa','staff');`);
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000bb','y@y.com');
  insert into profiles (id, name, student_id) values ('00000000-0000-0000-0000-0000000000bb','Pre2','00-0001');`);
const oldErr = await as("authenticated", "00000000-0000-0000-0000-0000000000bb", () => fails(() => q("select submit_claim(1, 'some owner detail here')")));
ok("BEFORE 0002: original submit_claim crashes (ambiguous column or unassigned record)", !!oldErr && /ambiguous|not assigned/i.test(oldErr), oldErr);
const logForge = await as("authenticated", "00000000-0000-0000-0000-0000000000bb", () => fails(() => q("select log_action('FAKE', 1, 'forged')")));
ok("BEFORE 0002: any signed-in user could call log_action", logForge === null);
await db.exec("delete from audit_log where true;").catch(() => {}); // blocked by the append-only trigger, expected
await db.exec("truncate audit_log, claim_attempts, items, claims restart identity cascade; delete from profiles; delete from auth.users;");

/* ---------- apply 0002 ---------- */
const sql = read("../migrations/0002_hardening_and_rpc.sql");
await db.exec(sql);
await db.exec(sql); // idempotent: running it twice must not error
ok("0002 applies, and applies twice", true);

const STAFF = "11111111-1111-1111-1111-111111111111", ALICE = "22222222-2222-2222-2222-222222222222",
  BOB = "33333333-3333-3333-3333-333333333333", CAROL = "44444444-4444-4444-4444-444444444444";
await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
  ('${STAFF}','staff@x.com','{"name":"Front Desk","student_id":"STAFF-01","role":"staff"}'),
  ('${ALICE}','alice@x.com','{"name":"Alice Finder","student_id":"24-00001"}'),
  ('${BOB}','bob@x.com','{"name":"Bob Owner","student_id":"24-00002"}'),
  ('${CAROL}','carol@x.com','{"name":"Carol Other","student_id":"24-00003"}');`);
const profs = await q("select id, name, student_id, role::text as role from profiles order by student_id");
ok("sign-up trigger creates a profile for each user", profs.length === 4, profs.length);
ok("role in client metadata is ignored (everyone starts as student)", profs.every((p) => p.role === "student"), profs.map((p) => p.role));
await db.exec(`update profiles set role = 'staff' where id = '${STAFF}'`);

const SELF = (title, extra = {}) => ["select to_jsonb(create_found_item($1,$2,$3,$4,$5,$6,$7,$8)) as r", [title, "umbrellas", "g-lib", ["black"], "left on a table", new Date().toISOString(), extra.secret ?? "wooden handle, initials MR on the strap", extra.photo ?? null]];

/* ---------- intake ---------- */
const mk = await as("authenticated", ALICE, () => q(...SELF("Black umbrella")));
const pend = mk[0].r;
ok("student item starts pending_dropoff with a 5-char code", pend.status === "pending_dropoff" && /^[A-HJKMNP-Z2-9]{5}$/.test(pend.code), pend);
ok("finder can read own pending item", (await as("authenticated", ALICE, () => q("select id from items"))).length === 1);
ok("other students cannot see a pending item", (await as("authenticated", BOB, () => q("select id from items"))).length === 0);
ok("anonymous visitors cannot see a pending item", (await as("anon", "", () => q("select id from items"))).length === 0);
ok("direct INSERT into items is refused", !!(await as("authenticated", ALICE, () => fails(() => q("insert into items (title,category,gate,finder_id) values ('x','bags','g-main',$1)", [ALICE])))));
ok("direct UPDATE of items is refused", !!(await as("authenticated", ALICE, () => fails(() => q("update items set status='claimed'")))));
ok("photo path must live in the caller's own folder", !!(await as("authenticated", ALICE, () => fails(() => q(...SELF("Photo item", { photo: BOB + "/a.jpg" }))))));
ok("own-folder photo path accepted", !(await as("authenticated", ALICE, () => fails(() => q(...SELF("Photo item two", { photo: ALICE + "/a.jpg" }))))));
await as("authenticated", ALICE, () => fails(() => q(...SELF("Third item"))));
const limited = await as("authenticated", ALICE, () => fails(() => q(...SELF("Fourth item"))));
ok("4th self-service report in 10 minutes is rate limited", /Too many reports/.test(limited || ""), limited);
const dup = await as("authenticated", ALICE, () => fails(() => q(...SELF("Black umbrella"))));
ok("duplicate report is rejected", /already reported|Too many/.test(dup || ""), dup);
const spamTitle = await as("authenticated", BOB, () => fails(() => q("select create_found_item('ab','umbrellas','g-lib','{}','', now())")));
ok("title shorter than 3 characters is rejected", /short title/.test(spamTitle || ""), spamTitle);
const oldFound = await as("authenticated", BOB, () => fails(() => q("select create_found_item('Old thing','umbrellas','g-lib','{}','', now() - interval '9 days')")));
ok("self-service found-time older than 7 days is rejected", /7 days/.test(oldFound || ""), oldFound);

/* ---------- drop-off ---------- */
const badCode = await as("authenticated", BOB, () => fails(() => q("select receive_item($1)", [pend.code])));
ok("a student cannot confirm drop-offs", /Staff access only/.test(badCode || ""), badCode);
await as("authenticated", STAFF, () => q("select receive_item($1)", [pend.code]));
const itemId = pend.id;
ok("staff receive_item moves the item to unclaimed and clears the code", (await q("select status::text s, code from items where id = $1", [itemId]))[0].s === "unclaimed");
ok("anonymous visitors can now see the item", (await as("anon", "", () => q("select id from items where id = $1", [itemId]))).length === 1);
ok("private detail is hidden from students", (await as("authenticated", BOB, () => q("select * from item_private"))).length === 0);
ok("private detail is hidden from anonymous visitors", (await as("anon", "", () => q("select * from item_private"))).length === 0);
ok("staff can read the private detail", (await as("authenticated", STAFF, () => q("select secret from item_private")))[0]?.secret.includes("wooden"));

/* ---------- claims ---------- */
const wrong1 = await as("authenticated", BOB, () => q("select submit_claim($1, 'a green backpack with books') as r", [itemId]));
ok("wrong claim returns ok:false and attemptsLeft:2", wrong1[0].r.ok === false && wrong1[0].r.attemptsLeft === 2, wrong1[0].r);
ok("a wrong claim never contains the secret", !JSON.stringify(wrong1[0].r).includes("wooden"));
await as("authenticated", BOB, () => q("select submit_claim($1, 'a purple lunch box somewhere') as r", [itemId]));
const wrong3 = await as("authenticated", BOB, () => q("select submit_claim($1, 'pink folder with stickers') as r", [itemId]));
ok("third wrong claim reports 0 attempts left", wrong3[0].r.attemptsLeft === 0, wrong3[0].r);
const locked = await as("authenticated", BOB, () => fails(() => q("select submit_claim($1, 'wooden handle initials MR strap') as r", [itemId])));
ok("after 3 failures even a correct claim is locked out", /Too many unsuccessful/.test(locked || ""), locked);
ok("claim_attempts is not readable by clients", !!(await as("authenticated", BOB, () => fails(() => q("select * from claim_attempts")))));
ok("claim_attempts cannot be reset by clients", !!(await as("authenticated", BOB, () => fails(() => q("delete from claim_attempts")))));
const own = await as("authenticated", ALICE, () => fails(() => q("select submit_claim($1, 'wooden handle initials MR strap') as r", [itemId])));
ok("the finder cannot claim their own item", /reported this item/.test(own || ""), own);

const good = await as("authenticated", CAROL, () => q("select submit_claim($1, 'wooden handle, initials MR on the strap') as r", [itemId]));
ok("matching claim succeeds", good[0].r.ok === true && good[0].r.claimId > 0, good[0].r);
const claimId = good[0].r.claimId;
ok("item becomes claim_pending", (await q("select status::text s from items where id = $1", [itemId]))[0].s === "claim_pending");
ok("claimant reads own claim (safe columns)", (await as("authenticated", CAROL, () => q("select id, status, details from claims"))).length === 1);
ok("claimant CANNOT read matched/missed/score", /permission denied/.test(await as("authenticated", CAROL, () => fails(() => q("select missed from claims"))) || ""));
ok("claimant CANNOT select * from claims", !!(await as("authenticated", CAROL, () => fails(() => q("select * from claims")))));
ok("other students cannot read someone else's claim", (await as("authenticated", BOB, () => q("select id from claims"))).length === 0);
const sc = await as("authenticated", STAFF, () => q("select * from staff_claims()"));
ok("staff_claims returns score + matched for staff", sc.length === 1 && Number(sc[0].claim_score) >= 0.5 && sc[0].claim_matched.length > 0 && sc[0].claimant_student_id === "24-00003", sc[0]);
ok("staff_claims returns nothing to students", (await as("authenticated", CAROL, () => q("select * from staff_claims()"))).length === 0);
ok("someone else cannot claim an item already claim_pending", /can't be claimed/.test(await as("authenticated", BOB, () => fails(() => q("select submit_claim($1, 'wooden handle initials MR') as r", [itemId]))) || ""));

/* ---------- decide, claimed visibility, rollback ---------- */
await as("authenticated", STAFF, () => q("select decide_claim($1, true)", [claimId]));
ok("approval moves item to claimed", (await q("select status::text s from items where id = $1", [itemId]))[0].s === "claimed");
ok("approved claimant can still read the claimed item (policy fix)", (await as("authenticated", CAROL, () => q("select id from items where id = $1", [itemId]))).length === 1);
ok("an unrelated student cannot read the claimed item", (await as("authenticated", BOB, () => q("select id from items where id = $1", [itemId]))).length === 0);
await as("authenticated", STAFF, () => q("select staff_rollback($1,'approve',$2)", [itemId, claimId]));
const rb = await q("select i.status::text s, c.status cs from items i join claims c on c.item_id = i.id where i.id = $1", [itemId]);
ok("rollback of an approval restores claim_pending + pending claim", rb[0].s === "claim_pending" && rb[0].cs === "pending", rb[0]);
await as("authenticated", STAFF, () => q("select decide_claim($1, false)", [claimId]));
ok("rejecting a claim returns the item to unclaimed", (await q("select status::text s from items where id = $1", [itemId]))[0].s === "unclaimed");
const stale = await as("authenticated", STAFF, () => fails(() => q("select staff_rollback($1,'approve',$2)", [itemId, claimId])));
ok("a rollback whose state has moved on is refused", /changed since/.test(stale || ""), stale);
ok("student cannot call staff_rollback", /Staff access only/.test(await as("authenticated", BOB, () => fails(() => q("select staff_rollback($1,'archive',null,'unclaimed')", [itemId]))) || ""));

/* ---------- item without a private detail (the unassigned-record bug) ---------- */
const noSecret = await as("authenticated", STAFF, () => q("select to_jsonb(create_found_item('Blue notebook','bags','g-main','{}','', now(), null)) as r"));
const nsId = noSecret[0].r.id;
ok("staff intake goes straight to unclaimed with no code", noSecret[0].r.status === "unclaimed" && noSecret[0].r.code === null, noSecret[0].r);
const manual = await as("authenticated", BOB, () => q("select submit_claim($1, 'has my name on the first page') as r", [nsId]));
ok("claiming an item with NO private detail works (manual check)", manual[0].r.ok === true, manual[0].r);
const mrow = await as("authenticated", STAFF, () => q("select claim_score, claim_matched from staff_claims() where claim_item_id = $1", [nsId]));
ok("manual claim stored with null score", mrow[0].claim_score === null, mrow[0]);

/* ---------- spam strikes ---------- */
const spamIds = [];
for (const t of ["Spam one", "Spam two"]) {
  const r = await as("authenticated", CAROL, () => q("select to_jsonb(create_found_item($1,'bags','g-main','{}','', now())) as r", [t]));
  spamIds.push(r[0].r.id);
}
await as("authenticated", STAFF, () => q("select reject_pending($1)", [spamIds[0]]));
ok("reject_pending archives the item", (await q("select status::text s from items where id = $1", [spamIds[0]]))[0].s === "archived");
ok("reject_pending adds a strike to the finder", (await q("select strikes from profiles where id = $1", [CAROL]))[0].strikes === 1);
await as("authenticated", STAFF, () => q("select reject_pending($1, 'spam')", [spamIds[1]]));
const paused = await as("authenticated", CAROL, () => fails(() => q("select create_found_item('Spam three','bags','g-main','{}','', now())")));
ok("two strikes pause self-service reporting", /paused/.test(paused || ""), paused);
await as("authenticated", STAFF, () => q("select staff_rollback($1,'rejectPending')", [spamIds[1]]));
ok("rollback of a rejection removes the strike", (await q("select strikes from profiles where id = $1", [CAROL]))[0].strikes === 1);

/* ---------- audit log + privileges ---------- */
const forged = await as("authenticated", BOB, () => fails(() => q("select log_action('FAKE', 1, 'forged')")));
ok("signed-in users can no longer call log_action", /permission denied/.test(forged || ""), forged);
ok("audit_log is readable by staff", (await as("authenticated", STAFF, () => q("select seq from audit_log"))).length > 5);
ok("audit_log is hidden from students", (await as("authenticated", BOB, () => q("select seq from audit_log"))).length === 0);
ok("audit_log rows cannot be edited (trigger)", /append-only/.test(await fails(() => q("update audit_log set detail = 'x'")) || ""));
ok("audit_log cannot be written directly by clients", !!(await as("authenticated", BOB, () => fails(() => q("insert into audit_log (action) values ('x')")))));
const actions = (await q("select distinct action from audit_log")).map((r) => r.action);
ok("audit trail records the full lifecycle", ["ITEM_LOGGED", "ITEM_VERIFIED", "CLAIM_FAILED", "CLAIM_SUBMITTED", "CLAIM_APPROVED", "CLAIM_REJECTED", "PENDING_REJECTED", "ROLLBACK"].every((a) => actions.includes(a)), actions);
ok("students cannot promote themselves to staff", !!(await as("authenticated", BOB, () => fails(() => q("update profiles set role = 'staff' where id = $1", [BOB])))));
ok("anonymous visitors cannot sign up a profile row directly", !!(await as("anon", "", () => fails(() => q("insert into profiles (id,name,student_id) values (gen_random_uuid(),'x','y')")))));

/* ---------- reports (students' one writable table) ---------- */
await as("authenticated", BOB, () => q("insert into reports (owner_id, title, category, gate) values ($1,'Lost umbrella','umbrellas','g-lib')", [BOB]));
ok("student can file a report as themselves", (await as("authenticated", BOB, () => q("select id from reports"))).length === 1);
ok("student cannot file a report as someone else", !!(await as("authenticated", BOB, () => fails(() => q("insert into reports (owner_id, title, category, gate) values ($1,'x','umbrellas','g-lib')", [CAROL])))));
ok("other students cannot read it", (await as("authenticated", CAROL, () => q("select id from reports"))).length === 0);
ok("student can close their own report", (await as("authenticated", BOB, () => q("update reports set status = 'closed' returning id"))).length === 1);

/* ---------- storage ---------- */
ok("upload into own folder allowed", !(await as("authenticated", ALICE, () => fails(() => q("insert into storage.objects (bucket_id, name) values ('item-photos', $1)", [ALICE + "/p.jpg"])))));
ok("upload into someone else's folder refused", !!(await as("authenticated", ALICE, () => fails(() => q("insert into storage.objects (bucket_id, name) values ('item-photos', $1)", [BOB + "/p.jpg"])))));
ok("anonymous upload refused", !!(await as("anon", "", () => fails(() => q("insert into storage.objects (bucket_id, name) values ('item-photos', 'x/p.jpg')")))));
ok("anonymous read of item photos allowed (signed URLs on the public search page)", (await as("anon", "", () => q("select name from storage.objects where bucket_id = 'item-photos'"))).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
