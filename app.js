/* FINDr UI. Renders views as HTML strings from FindrStore and wires delegated events. */
(function () {
  "use strict";
  const FS = globalThis.FindrStore;
  const { Store, STATUS: S, CATEGORIES, GATES, HOUR, DAY } = FS;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function safeStorage() {
    try { const k = "__findr_probe"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return localStorage; } catch (e) { return null; }
  }
  const ls = safeStorage();
  const lsGet = (k) => { try { return ls && ls.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (ls) { if (v == null) ls.removeItem(k); else ls.setItem(k, v); } } catch (e) {} };

  /* Backend mode: when window.FINDR_CONFIG has a Supabase url + key (injected at build time) the app runs on
     Supabase (real accounts, shared data). Without it the app runs on browser storage with demo data. */
  const CFG = (typeof window !== "undefined" && window.FINDR_CONFIG) || null;
  const REMOTE = !!(CFG && CFG.url && CFG.key && globalThis.FindrRemote);
  let store;
  if (REMOTE) {
    store = globalThis.FindrRemote.create(CFG, { kv: { get: lsGet, set: lsSet } });
  } else {
    store = new Store({ storage: ls });
    if (!store.loaded) store.seedDemo();
  }

  const VIEWS = ["search", "report", "found", "activity", "desk", "intake", "cleanup", "audit"];
  const ui = {
    view: "search", token: null, modal: null, loginTab: "student",
    q: "", cat: "", gate: "", since: "", sort: "relevance", suggest: [], sugIdx: -1,
    authMode: "signin", busy: false, loadError: null,
    photo: null, reportResult: null, foundResult: null, deskGate: "", auditItem: "", auditAction: "", confirmReset: false,
  };
  ui.token = REMOTE ? null : lsGet("findr.session");
  if (!REMOTE && !store.session(ui.token)) ui.token = null;

  const me = () => store.session(ui.token);
  const isStaff = () => { const s = me(); return !!s && s.role === "staff"; };

  /* ---------- formatting ---------- */
  const fmtDT = (ms, secs) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: secs ? "2-digit" : undefined });
  function ago(ms) {
    const d = Math.max(0, store.now() - ms);
    if (d < HOUR) return Math.max(1, Math.round(d / 60000)) + " min ago";
    if (d < DAY) return Math.round(d / HOUR) + " h ago";
    return Math.round(d / DAY) + " d ago";
  }
  const pad = (n) => String(n).padStart(2, "0");
  const dtLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const parseLocal = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : store.now(); };
  const HUES = [205, 160, 38, 280, 350, 100, 220, 20, 262, 182, 60];
  const hueOf = (cat) => HUES[Math.max(0, CATEGORIES.findIndex((c) => c[0] === cat)) % HUES.length];
  const BADGE = { PENDING_DROPOFF: "b-wait", UNCLAIMED: "b-ok", CLAIM_PENDING: "b-warn", CLAIMED: "b-done", ARCHIVED: "b-done" };
  const badge = (status) => `<span class="badge ${BADGE[status]}">${esc(FS.LABEL[status])}</span>`;
  const ACTION_TEXT = { ITEM_LOGGED: "Item logged", ITEM_VERIFIED: "Drop-off confirmed", PENDING_REJECTED: "Submission rejected", CLAIM_SUBMITTED: "Claim submitted", CLAIM_FAILED: "Claim failed", CLAIM_APPROVED: "Claim approved", CLAIM_REJECTED: "Claim rejected", RETENTION_FLAG: "Flagged for cleanup", RETENTION_SET: "Retention changed", ITEM_ARCHIVED: "Archived", ITEM_DONATED: "Donated", ROLLBACK: "Rollback", MATCH_ALERT: "Match alert", REPORT_FILED: "Report filed", REPORT_CLOSED: "Report closed" };
  const options = (list, sel, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : "") + list.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(l)}</option>`).join("");

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg, err) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "show" + (err ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ""; }, 4200);
  }
  function formErr(form, msg) {
    const el = form.querySelector ? form.querySelector(".formerr") : null;
    if (el) { el.textContent = msg; el.hidden = false; if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); } else toast(msg, true);
  }

  /* ---------- shared pieces ---------- */
  function tile(it) {
    if (it.photo) return `<button type="button" class="zoom" data-act="zoomPhoto" data-id="${esc(it.id)}" aria-label="Enlarge photo of ${esc(it.title)}"><img src="${esc(it.photo)}" alt="Photo of ${esc(it.title)}"></button>`;
    const initial = esc((it.categoryLabel || "?")[0]);
    return `<span class="tile" style="--h:${hueOf(it.category)}" aria-hidden="true">${initial}</span>`;
  }
  function card(it, extra) {
    const staff = isStaff();
    let claim = "";
    if (!staff) {
      claim = it.status === S.UNCLAIMED
        ? `<button class="btn primary small" data-act="openClaim" data-id="${esc(it.id)}">This is mine</button>`
        : `<button class="btn small" disabled>Claim in progress</button>`;
    }
    const compare = it.lookalikes > 0 ? `<button class="btn small" data-act="compare" data-id="${esc(it.id)}">Compare ${it.lookalikes} similar</button>` : "";
    return `<article class="ticket">
      <div class="stub">${tile(it)}<span class="tid">${esc(it.id)}</span></div>
      <div class="tbody">
        <div class="rowtop"><h3>${esc(it.title)}</h3>${badge(it.status)}</div>
        ${extra ? `<div class="score">${extra}</div>` : ""}
        <dl class="facts">
          <div><dt>Found</dt><dd>${esc(fmtDT(it.foundAt))} <span class="muted">(${ago(it.foundAt)})</span></dd></div>
          <div><dt>Where</dt><dd><span class="loc">${esc(it.gateName)}</span></dd></div>
        </dl>
        ${it.description ? `<p class="desc">${esc(it.description)}</p>` : ""}
        ${it.tags.length ? `<div class="tags">${it.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="actions">${claim}${compare}<button class="btn ghost small" data-act="share" data-id="${esc(it.id)}">Copy post text</button></div>
      </div></article>`;
  }
  function gateCard(text, staffOnly) {
    return `<div class="panel empty"><h3>${esc(text)}</h3>
      <button class="btn primary" data-act="signin" data-v="${staffOnly ? "staff" : "student"}">Sign in${staffOnly ? " as staff" : ""}</button></div>`;
  }

  /* ---------- header ---------- */
  function headerHTML() {
    const s = me();
    const items = [["search", "Search"]];
    let badges = {};
    if (s && s.role === "staff") {
      items.push(["desk", "Front desk"], ["intake", "Log an item"], ["cleanup", "Cleanup"], ["audit", "Audit log"]);
      badges = { desk: store.pendingQueue().length + store.claimQueue().length, cleanup: store.dueCount() };
    } else {
      items.push(["report", "Report missing"], ["found", "I found something"]);
      if (s) { items.push(["activity", "My activity"]); badges = { activity: store.unseenAlerts(ui.token) }; }
    }
    const nav = items.map(([v, l]) => `<button class="navbtn" data-act="go" data-v="${v}"${ui.view === v ? ' aria-current="page"' : ""}>${l}${badges[v] ? `<span class="count">${badges[v]}</span>` : ""}</button>`).join("");
    const who = s
      ? `<span><b>${esc(s.name)}</b> <span class="muted">${s.role === "staff" ? "Security staff" : "Student / employee"}</span></span><button class="btn small" data-act="signout">Sign out</button>`
      : `<button class="btn primary small" data-act="signin" data-v="student">Sign in</button>`;
    return `<div class="bar-in">
      <button class="brand" data-act="go" data-v="search" aria-label="FINDr home"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M3 12 12 3h8a1 1 0 0 1 1 1v8l-9 9a1.5 1.5 0 0 1-2 0L3 14a1.5 1.5 0 0 1 0-2Z" fill="currentColor"/><circle cx="16.5" cy="7.5" r="2" fill="var(--bg)"/></svg><span class="wm">FIND<b>r</b></span></button>
      <nav class="main" aria-label="Main">${nav}</nav><div class="who">${who}</div></div>`;
  }
  function renderHeader() { const h = $("#hdr"); if (h) h.innerHTML = headerHTML(); }

  /* ---------- search view ---------- */
  function runSearch() {
    const hrs = Number(ui.since);
    return store.search({ q: ui.q, category: ui.cat, gate: ui.gate, from: hrs ? store.now() - hrs * HOUR : null, sort: ui.sort });
  }
  function chipsHTML() {
    const cats = store.categories.values().filter((c) => c.count > 0 || c.id === ui.cat);
    const total = store.categories.values().reduce((n, c) => n + c.count, 0);
    const mk = (id, label, n) => `<button class="chip" data-act="pickCat" data-v="${esc(id)}" aria-pressed="${ui.cat === id}">${esc(label)} <span class="muted">${n}</span></button>`;
    return mk("", "All", total) + CATEGORIES.map(([id]) => cats.find((c) => c.id === id)).filter(Boolean).map((c) => mk(c.id, c.label, c.count)).join("");
  }
  function resultsHTML() {
    const r = runSearch();
    let head = `<p class="muted" aria-live="polite">${r.total} item${r.total === 1 ? "" : "s"} held by security${ui.q.trim() ? ` for “${esc(ui.q.trim())}”` : ""}</p>`;
    if (r.didYouMean) head += `<p>No exact match. Showing results for <button class="btn ghost small" data-act="pickAgain" data-v="${esc(r.didYouMean)}">${esc(r.didYouMean)}</button></p>`;
    if (!r.total) {
      return head + `<div class="panel empty"><h3>Nothing matches yet</h3>
        <p class="muted">Items appear here once security confirms them. Tell us what you lost and we will alert you when a match comes in.</p>
        <div class="actions"><button class="btn primary" data-act="go" data-v="report">Report it missing</button><button class="btn" data-act="clearFilters">Clear filters</button></div></div>`;
    }
    return head + `<div class="results">${r.results.map((x) => card(x.item)).join("")}</div>`;
  }
  function suggestHTML() {
    if (!ui.suggest.length) return "";
    return ui.suggest.map((s, i) => `<li role="option" id="sg${i}" data-act="pickSuggest" data-v="${esc(s)}" aria-selected="${i === ui.sugIdx}">${esc(s)}</li>`).join("");
  }
  function searchView() {
    const since = [["24", "Last 24 hours"], ["72", "Last 3 days"], ["168", "Last 7 days"], ["720", "Last 30 days"]];
    return `<section class="head"><h1>Lost something on campus?</h1>
      <p class="muted">Everything listed here is physically at a security desk. Search by what it is: “umbrella”, “payong”, “wallet”.</p></section>
      <section class="sect">
        <div class="searchbox">
          <label class="sr-only" for="q">Search lost items</label>
          <input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Start typing, e.g. umb…" value="${esc(ui.q)}" role="combobox" aria-expanded="${ui.suggest.length > 0}" aria-controls="suggest" aria-autocomplete="list">
          <ul id="suggest" class="suggest" role="listbox"${ui.suggest.length ? "" : " hidden"}>${suggestHTML()}</ul>
        </div>
        <div class="chips" id="chips">${chipsHTML()}</div>
        <div class="filters">
          <div class="field"><label for="f-gate">Location</label><select id="f-gate" data-set="gate">${options(GATES, ui.gate, "Any gate")}</select></div>
          <div class="field"><label for="f-since">Found</label><select id="f-since" data-set="since">${options(since, ui.since, "Any time")}</select></div>
          <div class="field"><label for="f-sort">Sort by</label><select id="f-sort" data-set="sort">${options([["relevance", "Best match"], ["newest", "Newest first"], ["oldest", "Oldest first"]], ui.sort)}</select></div>
        </div>
      </section>
      <section class="sect" id="results">${resultsHTML()}</section>`;
  }
  function refreshSearch() {
    const r = $("#results"), c = $("#chips"), sg = $("#suggest"), q = $("#q");
    if (r) r.innerHTML = resultsHTML();
    if (c) c.innerHTML = chipsHTML();
    if (sg) { sg.innerHTML = suggestHTML(); sg.hidden = !ui.suggest.length; }
    if (q) q.setAttribute("aria-expanded", String(ui.suggest.length > 0));
  }
  function updateSuggest() {
    const raw = ui.q;
    ui.suggest = raw.trim() ? store.suggest(raw).filter((s) => s !== raw.trim().toLowerCase()) : [];
    ui.sugIdx = -1;
  }

  /* ---------- report missing ---------- */
  function reportView() {
    if (isStaff()) return `<section class="head"><h1>Report a missing item</h1><p class="muted">Missing-item reports are filed by students and employees so the system can alert the owner. Use “Log an item” to record something handed to security.</p></section>`;
    if (!me()) return `<section class="head"><h1>Report a missing item</h1><p class="muted">We compare your report against every item security confirms, and alert you the moment one looks like yours.</p></section>${gateCard("Sign in to file a report")}`;
    if (ui.reportResult) {
      const { report, matches } = ui.reportResult;
      return `<section class="head"><h1>Report filed</h1><p class="muted">${esc(report.title)} · ${esc(report.id)}</p></section>
        ${matches.length
          ? `<section class="sect"><header><h2>${matches.length} possible match${matches.length === 1 ? "" : "es"} right now</h2></header><div class="results">${matches.map((m) => card(m.item, `Possible match ${Math.round(m.score * 100)}%`)).join("")}</div></section>`
          : `<div class="panel stack"><h2>No match yet</h2><p class="muted">When security confirms an item that fits your description, an alert will appear under My activity.</p></div>`}
        <div class="actions"><button class="btn" data-act="reportAgain">File another report</button><button class="btn primary" data-act="go" data-v="activity">Go to My activity</button></div>`;
    }
    return `<section class="head"><h1>Report a missing item</h1>
      <p class="muted">Describe it the way you would to a friend. We match it against every item security confirms, now and later, and alert you.</p></section>
      <form class="panel stack" data-form="report" id="report-form">
        <div class="grid2">
          <div class="field"><label for="r-title">What did you lose?</label><input id="r-title" name="title" type="text" maxlength="60" placeholder="Black umbrella with a wooden handle" required></div>
          <div class="field"><label for="r-cat">Category</label><select id="r-cat" name="category" required>${options(CATEGORIES, "", "Choose one")}</select></div>
          <div class="field"><label for="r-gate">Where did you last have it?</label><select id="r-gate" name="gate" required>${options(GATES, "", "Choose a location")}</select></div>
          <div class="field"><label for="r-when">About when?</label><input id="r-when" name="lostAt" type="datetime-local" value="${dtLocal(store.now())}"></div>
          <div class="field"><label for="r-tags">Colors, brand, keywords</label><input id="r-tags" name="tags" type="text" placeholder="black, folding, payong"><span class="help">Separate with commas.</span></div>
          <div class="field"><label for="r-contact">How should we reach you?</label><input id="r-contact" name="contact" type="text" placeholder="Email or phone"></div>
        </div>
        <div class="field"><label for="r-desc">Anything else?</label><textarea id="r-desc" name="description" maxlength="300" placeholder="Where you sat, what was inside, when you noticed it was gone"></textarea></div>
        <div class="formerr" role="alert" hidden></div>
        <div><button class="btn primary" type="submit">File report</button></div>
      </form>`;
  }

  /* ---------- found + staff intake (same form) ---------- */
  function foundView(staff) {
    if (!me()) return `<section class="head"><h1>I found something</h1><p class="muted">Log it here, then hand it to the guard at the gate. The guard only has to confirm a drop-off code.</p></section>${gateCard("Sign in to log a found item")}`;
    if (ui.foundResult) {
      const { item, alerts } = ui.foundResult;
      const body = staff
        ? `<div class="panel stack"><h2>${esc(item.title)} is now unclaimed</h2><p class="muted">Logged as ${esc(item.id)} at ${esc(item.gateName)}.${alerts ? ` It matched ${alerts} open report${alerts === 1 ? "" : "s"}, and the owner${alerts === 1 ? " was" : "s were"} alerted.` : ""}${item.secret ? "" : " No private detail is on file, so claims will need a manual check."}</p></div>`
        : `<div class="panel stack"><h2>Hand it to the guard at ${esc(item.gateName)}</h2>
            <p class="muted">Show this code. Your item stays hidden from searches until security confirms they hold it.</p>
            <div><span class="code">${esc(item.code)}</span></div>
            <p class="help">You can find this code again under My activity.</p></div>`;
      return `<section class="head"><h1>${staff ? "Item logged" : "Thanks for turning it in"}</h1></section>${body}
        <div class="actions"><button class="btn primary" data-act="foundAgain">${staff ? "Log another item" : "Report another item"}</button><button class="btn" data-act="go" data-v="${staff ? "desk" : "search"}">${staff ? "Back to front desk" : "Back to search"}</button></div>`;
    }
    return `<section class="head"><h1>${staff ? "Log a received item" : "I found something"}</h1>
      <p class="muted">${staff ? "Items logged here go straight to Unclaimed. Add a private detail so owners can be verified." : "Takes about a minute on a phone. Then drop the item at the gate. The guard only confirms your code."}</p></section>
      <form class="panel stack" data-form="found" data-staff="${staff ? 1 : 0}" id="found-form">
        <div class="grid2">
          <div class="field"><label for="f-title">What is it?</label><input id="f-title" name="title" type="text" maxlength="60" placeholder="Blue water bottle" required></div>
          <div class="field"><label for="f-cat">Category</label><select id="f-cat" name="category" required>${options(CATEGORIES, "", "Choose one")}</select></div>
          <div class="field"><label for="f-gate2">${staff ? "Location tag" : "Found near · drop-off gate"}</label><select id="f-gate2" name="gate" required>${options(GATES, "", "Choose a gate")}</select></div>
          <div class="field"><label for="f-when">When did you find it?</label><input id="f-when" name="foundAt" type="datetime-local" value="${dtLocal(store.now())}"></div>
          <div class="field"><label for="f-tags">Colors, brand, keywords</label><input id="f-tags" name="tags" type="text" placeholder="blue, steel, 32oz"><span class="help">Separate with commas. These make it searchable.</span></div>
          <div class="field"><label for="photo">Photo</label><input id="photo" type="file" accept="image/*" capture="environment"><span class="help">Keep stickers, scratches and screens out of the shot.</span></div>
        </div>
        <div id="photoPrev"></div>
        <div class="field"><label for="f-desc">Public description</label><textarea id="f-desc" name="description" maxlength="300" placeholder="Where exactly you found it. Anyone searching can read this."></textarea></div>
        <div class="field"><label for="f-secret">Private detail (hidden from searchers)</label><textarea id="f-secret" name="secret" maxlength="300" placeholder="Something only the owner would know: a sticker, a scratch, what is inside, the lock screen photo"></textarea><span class="help">Owners must describe this before they can claim the item.</span></div>
        <div class="hp" aria-hidden="true"><label for="f-web">Website</label><input id="f-web" name="website" type="text" tabindex="-1" autocomplete="off"></div>
        <div class="formerr" role="alert" hidden></div>
        <div><button class="btn primary" type="submit">${staff ? "Log item" : "Get my drop-off code"}</button></div>
      </form>`;
  }

  /* ---------- student activity ---------- */
  function activityView() {
    if (!me()) return `<section class="head"><h1>My activity</h1></section>${gateCard("Sign in to see your reports and claims")}`;
    const reps = store.myReports(ui.token), claims = store.myClaims(ui.token), finds = store.myFinds(ui.token);
    const CL = { PENDING: ["b-warn", "Waiting for staff review"], APPROVED: ["b-ok", "Approved"], REJECTED: ["b-bad", "Not approved"], CANCELLED: ["b-done", "Cancelled"] };
    return `<section class="head"><h1>My activity</h1><p class="muted">Signed in as ${esc(me().name)} (${esc(me().studentId)}).</p></section>
      <section class="sect"><header><h2>Missing-item reports</h2><button class="btn small" data-act="go" data-v="report">New report</button></header>
        ${reps.length ? reps.map(({ report: r, alerts }) => `<div class="panel stack">
          <div class="rowtop"><div><h3>${esc(r.title)}</h3><p class="muted">${esc(r.id)} · lost ${esc(fmtDT(r.lostAt))} · ${esc(store.gates.get(r.gate).name)}</p></div>${r.status === "OPEN" ? `<span class="badge b-wait">Watching</span>` : `<span class="badge b-done">Closed</span>`}</div>
          ${alerts.length ? `<div class="results">${alerts.map((a) => card(a.item, `Possible match ${Math.round(a.alert.score * 100)}%`)).join("")}</div>` : `<p class="muted">No match yet. You will see an alert here when a matching item is confirmed.</p>`}
          ${r.status === "OPEN" ? `<div><button class="btn small" data-act="closeReport" data-id="${esc(r.id)}">I found it, close this report</button></div>` : ""}
        </div>`).join("") : `<div class="panel muted">You have not reported anything missing.</div>`}</section>
      <section class="sect"><header><h2>My claims</h2></header>
        ${claims.length ? `<div class="panel tight"><ul class="rows">${claims.map(({ claim: c, item }) => `<li><div class="main"><b>${esc(item.title)}</b><span class="muted">${esc(c.id)} · ${esc(fmtDT(c.at))}</span>${c.status === "APPROVED" ? `<span>Bring your ID to the ${esc(item.gateName)}.</span>` : ""}</div><span class="badge ${CL[c.status][0]}">${CL[c.status][1]}</span></li>`).join("")}</ul></div>` : `<div class="panel muted">No claims yet. Find your item in Search and choose “This is mine”.</div>`}</section>
      <section class="sect"><header><h2>Items I turned in</h2></header>
        ${finds.length ? `<div class="panel tight"><ul class="rows">${finds.map((f) => `<li><div class="main"><b>${esc(f.title)}</b><span class="muted">${esc(f.id)} · ${esc(f.gateName)}</span>${f.status === S.PENDING ? `<span>Show code <span class="code small">${esc(f.code)}</span> to the guard.</span>` : ""}</div>${badge(f.status)}</li>`).join("")}</ul></div>` : `<div class="panel muted">Nothing turned in yet.</div>`}</section>`;
  }

  /* ---------- staff: front desk ---------- */
  function deskView() {
    if (!isStaff()) return `<section class="head"><h1>Front desk</h1></section>${gateCard("Staff sign-in required", true)}`;
    const st = store.stats(), pend = store.pendingQueue(ui.deskGate), claims = store.claimQueue(), up = store.undoPeek();
    const upItem = up ? store.getItem(up.itemId) : null;
    return `<section class="head"><h1>Front desk</h1>
      <div class="strip"><span><b>${st.byStatus.PENDING_DROPOFF}</b>awaiting drop-off</span><span><b>${st.openClaims}</b>claims to review</span><span><b>${st.byStatus.UNCLAIMED}</b>unclaimed</span><span><b>${st.due}</b>past retention</span></div></section>
      ${up ? `<div class="callout"><span>Last change: <b>${esc(upItem.title)}</b> (${esc(upItem.id)}) moved to ${esc(FS.LABEL[up.to])}.</span><button class="btn small" data-act="undo">Undo</button></div>` : ""}
      <section class="sect"><header><h2>Confirm a drop-off</h2><span class="muted">One step: type the code the student shows you.</span></header>
        <form class="panel" data-form="receiveCode" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
          <div class="field" style="flex:1 1 200px"><label for="code">Drop-off code</label><input id="code" name="code" type="text" autocomplete="off" autocapitalize="characters" maxlength="5" placeholder="K7M2Q" class="mono"></div>
          <button class="btn primary" type="submit">Mark received</button></form></section>
      <section class="sect"><header><h2>Waiting for drop-off</h2>
        <div class="field" style="min-width:200px"><label class="sr-only" for="dg">Gate</label><select id="dg" data-set="deskGate">${options(GATES, ui.deskGate, "All gates")}</select></div></header>
        ${pend.length ? `<div class="panel tight"><ul class="rows">${pend.map((p) => `<li><div class="main"><span><b>${esc(p.title)}</b> <span class="muted">${esc(p.id)}</span> ${p.stale ? `<span class="badge b-warn">No drop-off after 48 h</span>` : ""}</span>
          <span class="muted">${esc(p.finderName)} (${esc(p.finderId)}) · ${esc(p.gateName)} · logged ${ago(p.createdAt)}</span>
          <span>Code <span class="code small">${esc(p.code)}</span></span>
          ${p.secret ? "" : `<input class="inline" id="sec-${esc(p.id)}" type="text" placeholder="Private detail (optional)" aria-label="Private detail for ${esc(p.title)}">`}</div>
          <div class="btns"><button class="btn primary small" data-act="receive" data-id="${esc(p.id)}">Received</button><button class="btn danger small" data-act="rejectPending" data-id="${esc(p.id)}">Reject as spam</button></div></li>`).join("")}</ul></div>` : `<div class="panel muted">Nothing is waiting at ${ui.deskGate ? esc(store.gates.get(ui.deskGate).name) : "any gate"}.</div>`}</section>
      <section class="sect"><header><h2>Claims to review</h2><span class="muted">Check the claimant's ID at the counter before releasing.</span></header>
        ${claims.length ? `<div class="panel tight"><ul class="rows">${claims.map(({ claim: c, item }) => `<li><div class="main">
          <span><b>${esc(item.title)}</b> <span class="muted">${esc(item.id)} · ${esc(item.gateName)} · found ${esc(fmtDT(item.foundAt))}</span></span>
          <span><span class="muted">On file:</span> ${item.secret ? esc(item.secret) : `<span class="badge b-warn">No private detail on file, check by hand</span>`}</span>
          <span><span class="muted">${esc(c.claimantName)} (${esc(c.claimantId)}) says:</span> “${esc(c.details)}”</span>
          ${c.manual ? "" : `<span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="meter${c.score < 0.7 ? "" : ""}" style="width:140px"><i style="width:${Math.round(c.score * 100)}%"></i></span><b>${Math.round(c.score * 100)}% match</b>
            ${c.matched.map((t) => `<span class="badge b-ok">${esc(t)}</span>`).join("")}${c.missed.map((t) => `<span class="badge b-bad">${esc(t)}</span>`).join("")}</span>`}
          </div><div class="btns"><button class="btn primary small" data-act="approve" data-id="${esc(c.id)}">Approve and release</button><button class="btn danger small" data-act="rejectClaim" data-id="${esc(c.id)}">Reject</button></div></li>`).join("")}</ul></div>` : `<div class="panel muted">No claims waiting.</div>`}</section>`;
  }

  /* ---------- staff: retention cleanup ---------- */
  function cleanupView() {
    if (!isStaff()) return `<section class="head"><h1>Cleanup</h1></section>${gateCard("Staff sign-in required", true)}`;
    const lim = store.settings.retentionDays, q = store.retentionQueue(60), due = q.filter((r) => r.due).length;
    return `<section class="head"><h1>Cleanup</h1><p class="muted">Unclaimed items ranked oldest first. Anything past the retention limit is flagged for archiving or donation.</p></section>
      <div class="panel stack">
        <div class="field"><label for="ret">Retention limit: <b id="retv">${lim} days</b></label><input id="ret" type="range" min="30" max="60" step="1" value="${lim}" data-change="retention"></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between"><span><b>${due}</b> of ${q.length} unclaimed items are past the limit.</span>
        <span class="actions"><button class="btn small" data-act="processOldest" data-d="archived"${due ? "" : " disabled"}>Archive the oldest</button><button class="btn small" data-act="processOldest" data-d="donated"${due ? "" : " disabled"}>Donate the oldest</button></span></div></div>
      <section class="sect">${q.length ? `<div class="panel tight"><ul class="rows">${q.map((r, i) => {
        const it = r.item, pct = Math.min(100, Math.round((r.ageDays / lim) * 100));
        return `<li><div class="main"><span><span class="muted">#${i + 1}</span> <b>${esc(it.title)}</b> <span class="muted">${esc(it.id)} · ${esc(it.gateName)}</span></span>
          <span style="display:flex;gap:10px;align-items:center"><span class="meter${r.due ? " over" : ""}" style="width:160px"><i style="width:${pct}%"></i></span><span class="mono">${r.ageDays.toFixed(0)} d</span>${r.due ? `<span class="badge b-bad">${r.daysOver.toFixed(0)} d over</span>` : `<span class="badge b-done">Within limit</span>`}</span></div>
          <div class="btns">${r.due ? `<button class="btn small" data-act="archive" data-id="${esc(it.id)}" data-d="archived">Archive</button><button class="btn small" data-act="archive" data-id="${esc(it.id)}" data-d="donated">Donate</button>` : ""}</div></li>`;
      }).join("")}</ul></div>` : `<div class="panel muted">No unclaimed items.</div>`}</section>`;
  }

  /* ---------- staff: audit ---------- */
  function auditView() {
    if (!isStaff()) return `<section class="head"><h1>Audit log</h1></section>${gateCard("Staff sign-in required", true)}`;
    const rows = store.auditLog({ itemId: ui.auditItem.trim().toUpperCase(), action: ui.auditAction }).slice(0, 200);
    const hist = ui.auditItem.trim() ? store.itemHistory(ui.auditItem.trim().toUpperCase()) : [];
    const st = store.stats();
    return `<section class="head"><h1>Audit log</h1><p class="muted">Every status change and staff action, in order. Entries are never edited. A rollback adds a new entry.</p></section>
      <div class="filters"><div class="field"><label for="a-item">Item ID</label><input id="a-item" type="text" value="${esc(ui.auditItem)}" placeholder="I-0001" data-change="auditItem"></div>
        <div class="field"><label for="a-act">Action</label><select id="a-act" data-set="auditAction">${options(Object.entries(ACTION_TEXT), ui.auditAction, "All actions")}</select></div></div>
      ${hist.length ? `<div class="panel stack"><h3>State history for ${esc(ui.auditItem.toUpperCase())} <span class="muted">(top of stack first)</span></h3><div class="chips">${hist.map((h) => `<span class="badge b-wait">${esc(h.from ? FS.LABEL[h.from] + " → " : "")}${esc(FS.LABEL[h.to])}</span>`).join("")}</div></div>` : ""}
      <div class="panel tight"><div class="tablewrap"><table><thead><tr><th class="num">#</th><th>Time</th><th>Who</th><th>Action</th><th>Item</th><th>Detail</th></tr></thead><tbody>
        ${rows.map((e) => `<tr><td class="num">${e.seq}</td><td>${esc(fmtDT(e.at, true))}</td><td>${esc(e.actor)} <span class="muted">${esc(e.role)}</span></td><td>${esc(ACTION_TEXT[e.action] || e.action)}</td><td class="mono">${esc(e.itemId || "")}</td><td>${esc(e.detail)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No entries match.</td></tr>`}
      </tbody></table></div></div>
      <section class="sect"><header><h2>Under the hood</h2></header><dl class="hood">
        <div><dt>Trie</dt><dd>${st.trieWords} words indexed for prefix search and auto-complete</dd></div>
        <div><dt>Hash table with chaining</dt><dd>${st.hash.size} items in ${st.hash.buckets} buckets, longest chain ${st.hash.longestChain}</dd></div>
        <div><dt>Max-heap</dt><dd>${store.retentionQueue(1e9).length} unclaimed items ranked by age</dd></div>
        <div><dt>Stack</dt><dd>${store.undoStack.size} reversible changes, ${store.audit.length} log entries</dd></div>
        <div><dt>Sorting and searching</dt><dd>Merge sort orders results. Binary search narrows date ranges. Edit distance checks claims and typos.</dd></div></dl></section>`;
  }

  /* ---------- modals ---------- */
  function modalHTML() {
    const m = ui.modal;
    if (!m) return "";
    const close = `<button class="btn small" data-act="closeModal" aria-label="Close">Close</button>`;
    let inner = "", wide = "";
    if (m.type === "signin" && REMOTE) {
      const su = ui.authMode === "signup";
      inner = `<header><h2>${su ? "Create your account" : "Sign in"}</h2>${close}</header>
        <div class="tabs" role="tablist"><button role="tab" aria-selected="${!su}" data-act="tab" data-v="signin">Sign in</button><button role="tab" aria-selected="${su}" data-act="tab" data-v="signup">Create account</button></div>
        ${m.note ? `<p class="muted">${esc(m.note)}</p>` : ""}
        <form class="stack" data-form="signin" data-role="auth">
          ${su ? `<div class="field"><label for="s-name">Full name</label><input id="s-name" name="name" type="text" autocomplete="name" required autofocus></div>
            <div class="field"><label for="s-id">Student or employee ID</label><input id="s-id" name="studentId" type="text" autocomplete="off" placeholder="24-01234" required></div>` : ""}
          <div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" autocomplete="email" required${su ? "" : " autofocus"}></div>
          <div class="field"><label for="s-pw">Password</label><input id="s-pw" name="password" type="password" autocomplete="${su ? "new-password" : "current-password"}" minlength="6" required>${su ? `<span class="help">At least 6 characters.</span>` : ""}</div>
          <div class="formerr" role="alert" hidden></div>
          <button class="btn primary" type="submit"${ui.busy ? " disabled" : ""}>${su ? "Create account" : "Sign in"}</button></form>`;
    } else if (m.type === "signin") {
      const st = ui.loginTab === "staff";
      inner = `<header><h2>Sign in</h2>${close}</header>
        <div class="tabs" role="tablist"><button role="tab" aria-selected="${!st}" data-act="tab" data-v="student">Student / employee</button><button role="tab" aria-selected="${st}" data-act="tab" data-v="staff">Security staff</button></div>
        ${m.note ? `<p class="muted">${esc(m.note)}</p>` : ""}
        <form class="stack" data-form="signin" data-role="${st ? "staff" : "student"}">
          <div class="field"><label for="s-name">Full name</label><input id="s-name" name="name" type="text" autocomplete="name" required autofocus></div>
          ${st ? `<div class="field"><label for="s-pin">Staff PIN</label><input id="s-pin" name="pin" type="password" autocomplete="off" required><span class="help">Demo PIN: 2026</span></div>`
               : `<div class="field"><label for="s-id">Student or employee ID</label><input id="s-id" name="studentId" type="text" autocomplete="off" placeholder="24-01234" required><span class="help">Demo: Jamie Cruz, 24-01234, has a match alert waiting.</span></div>`}
          <div class="formerr" role="alert" hidden></div>
          <button class="btn primary" type="submit">Sign in</button></form>`;
    } else if (m.type === "claim") {
      const it = store.getItem(m.id);
      inner = `<header><div><h2>Claim ${esc(it.title)}</h2><p class="muted">${esc(it.id)} · found ${esc(fmtDT(it.foundAt))} · ${esc(it.gateName)}</p></div>${close}</header>
        <form class="stack" data-form="claim"><input type="hidden" name="id" value="${esc(it.id)}">
          <div class="field"><label for="c-det">What can you tell us that only the owner would know?</label><textarea id="c-det" name="details" maxlength="300" required autofocus placeholder="Marks, stickers, scratches, what is inside, lock screen photo"></textarea>
          <span class="help">Security compares this with details kept private. Don't post these publicly. You have 3 tries.</span></div>
          <div class="field"><label for="c-con">How should we reach you?</label><input id="c-con" name="contact" type="text" placeholder="Email or phone"></div>
          <div class="formerr" role="alert" hidden></div>
          <button class="btn primary" type="submit">Send claim</button></form>`;
    } else if (m.type === "claimDone") {
      inner = `<header><h2>Claim sent</h2>${close}</header><p>Security will review it. Bring a valid ID to the <b>${esc(m.gate)}</b> to collect <b>${esc(m.title)}</b>. You can follow the status under My activity.</p>
        <div class="actions"><button class="btn primary" data-act="closeModal">Done</button></div>`;
    } else if (m.type === "photo") {
      const it = store.getItem(m.id, isStaff());
      wide = " photo";
      inner = `<header><div><h2>${esc(it.title)}</h2><p class="muted">${esc(it.id)} · ${esc(it.gateName)}</p></div>${close}</header>
        <img src="${esc(it.photo)}" alt="Full size photo of ${esc(it.title)}">`;
    } else if (m.type === "compare") {
      const list = store.lookalikes(m.id);
      wide = " wide";
      inner = `<header><div><h2>Compare similar items</h2><p class="muted">Same description, different time and place. Pick the one you lost near.</p></div>${close}</header>
        <div class="tablewrap"><table><thead><tr><th>Item</th><th>Found</th><th>Where</th><th>Notes</th><th></th></tr></thead><tbody>
        ${list.map((x) => `<tr><td><b>${esc(x.title)}</b><br><span class="mono muted">${esc(x.id)}</span></td><td>${esc(fmtDT(x.foundAt))}<br><span class="muted">${ago(x.foundAt)}</span></td><td><span class="loc">${esc(x.gateName)}</span></td><td>${esc(x.description)}${x.tags.length ? `<br>${x.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}` : ""}</td>
          <td>${isStaff() ? "" : x.status === S.UNCLAIMED ? `<button class="btn primary small" data-act="openClaim" data-id="${esc(x.id)}">This one</button>` : `<span class="badge b-warn">Claim in progress</span>`}</td></tr>`).join("")}
        </tbody></table></div>`;
    }
    return `<div class="scrim" data-act="scrim"><div class="modal${wide}" role="dialog" aria-modal="true">${inner}</div></div>`;
  }

  /* ---------- render ---------- */
  const views = {
    search: searchView, report: reportView, found: () => foundView(isStaff()), intake: () => (isStaff() ? foundView(true) : `<section class="head"><h1>Log an item</h1></section>${gateCard("Staff sign-in required", true)}`),
    activity: activityView, desk: deskView, cleanup: cleanupView, audit: auditView,
  };
  function render() {
    const app = $("#app");
    if (!app) return;
    if (!views[ui.view]) ui.view = "search";
    app.innerHTML = `<header id="hdr">${headerHTML()}</header><main class="wrap" id="main">${views[ui.view]()}</main>
      <footer class="foot wrap">${REMOTE ? `<span>Connected to Supabase. Data is shared and saved online.</span>` : `<span>Demo data is saved in this browser only.</span><button class="btn ghost small" data-act="resetDemo">${ui.confirmReset ? "Click again to erase and reload demo data" : "Reset demo data"}</button>`}</footer>${modalHTML()}`;
    if (ui.modal) { const f = $(".modal [autofocus]"); if (f && f.focus) f.focus(); }
  }
  function go(view) {
    ui.view = view; ui.modal = null; ui.confirmReset = false;
    if (view === "report" && ui.reportResult && ui.reportResult.stale) ui.reportResult = null;
    try { if (typeof location !== "undefined") location.hash = view; } catch (e) {}
    render();
    if (view === "activity" && me()) { store.markAlertsSeen(ui.token); renderHeader(); }
    if (REMOTE) syncRemote(view);
    if (typeof window !== "undefined" && window.scrollTo) window.scrollTo(0, 0);
  }
  /* Remote mode: reload the read model when the visitor changes page, then redraw unless they are mid-form. */
  function syncRemote(view) {
    store.refresh().then(() => {
      if (ui.view !== view || ui.modal || ["report", "found", "intake"].includes(view)) { renderHeader(); return; }
      if (view === "search") { refreshSearch(); renderHeader(); } else render();
    }, (e) => toast("Could not refresh: " + e.message, true));
  }
  const guard = (fn) => (...a) => {
    const fail = (e) => toast((e && e.message) || String(e), true);
    try { const r = fn(...a); return r && typeof r.then === "function" ? r.catch(fail) : r; } catch (e) { fail(e); }
  };

  /* ---------- actions (click) ---------- */
  const actions = {
    go: (el) => go(el.dataset.v),
    signin: (el) => { ui.loginTab = el.dataset.v === "staff" ? "staff" : "student"; ui.authMode = "signin"; ui.modal = { type: "signin" }; render(); },
    tab: (el) => { if (REMOTE) ui.authMode = el.dataset.v === "signup" ? "signup" : "signin"; else ui.loginTab = el.dataset.v; ui.modal = { type: "signin", note: ui.modal && ui.modal.note }; render(); },
    signout: guard(async () => { await store.logout(ui.token); ui.token = null; lsSet("findr.session", null); ui.reportResult = null; ui.foundResult = null; go(["search", "report", "found"].includes(ui.view) ? ui.view : "search"); toast("Signed out."); }),
    closeModal: () => { ui.modal = null; render(); },
    scrim: (el, ev) => { if (ev.target === el) { ui.modal = null; render(); } },
    openClaim: (el) => {
      if (!me()) { ui.loginTab = "student"; ui.authMode = "signin"; ui.modal = { type: "signin", note: "Sign in to claim this item." }; return render(); }
      ui.modal = { type: "claim", id: el.dataset.id }; render();
    },
    zoomPhoto: (el) => { ui.modal = { type: "photo", id: el.dataset.id }; render(); },
    compare: (el) => { ui.modal = { type: "compare", id: el.dataset.id }; render(); },
    share: (el) => {
      const it = store.getItem(el.dataset.id);
      const text = `FOUND: ${it.title}. Held by security (${it.gateName}), found ${fmtDT(it.foundAt)}. Search FINDr and quote ${it.id} to claim it.`;
      const done = () => toast("Post text copied. Paste it into the community page.");
      try { navigator.clipboard.writeText(text).then(done, () => toast(text)); } catch (e) { toast(text); }
    },
    pickSuggest: (el) => { ui.q = el.dataset.v + " "; ui.suggest = []; ui.sugIdx = -1; const q = $("#q"); if (q) { q.value = ui.q; q.focus(); } refreshSearch(); },
    pickCat: (el) => { ui.cat = el.dataset.v; refreshSearch(); },
    pickAgain: (el) => { ui.q = el.dataset.v; const q = $("#q"); if (q) q.value = ui.q; updateSuggest(); refreshSearch(); },
    clearFilters: () => { ui.q = ""; ui.cat = ""; ui.gate = ""; ui.since = ""; ui.sort = "relevance"; ui.suggest = []; render(); },
    reportAgain: () => { ui.reportResult = null; render(); },
    foundAgain: () => { ui.foundResult = null; ui.photo = null; render(); },
    closeReport: guard(async (el) => { await store.closeReport(ui.token, el.dataset.id); toast("Report closed."); render(); }),
    receive: guard(async (el) => {
      const sec = $("#sec-" + el.dataset.id);
      const r = await store.receiveItem(ui.token, el.dataset.id, sec ? sec.value : "");
      toast(`${r.item.title} confirmed${r.alerts ? ` · ${r.alerts} owner alert${r.alerts === 1 ? "" : "s"} sent` : ""}`); render();
    }),
    rejectPending: guard(async (el) => { await store.rejectPending(ui.token, el.dataset.id, "spam / never dropped off"); toast("Submission rejected."); render(); }),
    approve: guard(async (el) => { const it = await store.approveClaim(ui.token, el.dataset.id); toast(`${it.title} released.`); render(); }),
    rejectClaim: guard(async (el) => { await store.rejectClaim(ui.token, el.dataset.id); toast("Claim rejected. The item is unclaimed again."); render(); }),
    undo: guard(async () => { const it = await store.undo(ui.token); toast(`Reverted ${it.title} to ${FS.LABEL[it.status]}.`); render(); }),
    archive: guard(async (el) => { const it = await store.archiveItem(ui.token, el.dataset.id, el.dataset.d); toast(`${it.title} ${it.disposition}.`); render(); }),
    processOldest: guard(async (el) => { const it = await store.processOldest(ui.token, el.dataset.d); toast(`${it.title} ${it.disposition}.`); render(); }),
    resetDemo: () => {
      if (REMOTE) return;
      if (!ui.confirmReset) { ui.confirmReset = true; return render(); }
      store.clearAll(); store.seedDemo(); ui.token = null; lsSet("findr.session", null);
      Object.assign(ui, { q: "", cat: "", gate: "", since: "", suggest: [], reportResult: null, foundResult: null, confirmReset: false, modal: null });
      go("search"); toast("Demo data reset.");
    },
  };

  /* ---------- forms (submit) ---------- */
  const readForm = (f) => f.__values || Object.fromEntries(new FormData(f));
  const forms = {
    async signin(f) {
      const v = readForm(f);
      if (REMOTE) {
        if (ui.busy) return;
        ui.busy = true;
        try {
          let p;
          if (ui.authMode === "signup") {
            const r = await store.signUp({ email: v.email, password: v.password, name: v.name, studentId: v.studentId });
            if (r.needsConfirmation) { ui.busy = false; return formErr(f, "Account created. Check your email to confirm it, then sign in."); }
            p = r.profile;
          } else p = await store.signIn({ email: v.email, password: v.password });
          ui.token = p.token; ui.modal = null;
          go(p.role === "staff" ? "desk" : ui.view);
          toast(`Signed in as ${p.name}.`);
        } catch (e) { formErr(f, e.message); } finally { ui.busy = false; }
        return;
      }
      try {
        const s = store.login(f.dataset.role, { name: v.name, studentId: v.studentId, pin: v.pin });
        ui.token = s.token; lsSet("findr.session", s.token); ui.modal = null;
        go(s.role === "staff" ? "desk" : ui.view);
        toast(`Signed in as ${s.name}.`);
      } catch (e) { formErr(f, e.message); }
    },
    async claim(f) {
      const v = readForm(f);
      try {
        const r = await store.submitClaim(ui.token, v.id, v.details, v.contact);
        if (!r.ok) return formErr(f, `${r.message} (${r.attemptsLeft} ${r.attemptsLeft === 1 ? "try" : "tries"} left)`);
        const it = store.getItem(v.id);
        ui.modal = { type: "claimDone", title: it.title, gate: it.gateName }; render(); renderHeader();
        if (ui.view === "search") refreshSearch();
      } catch (e) { formErr(f, e.message); }
    },
    async report(f) {
      const v = readForm(f);
      try {
        ui.reportResult = await store.createReport(ui.token, { title: v.title, category: v.category, gate: v.gate, lostAt: parseLocal(v.lostAt), tags: v.tags, description: v.description, contact: v.contact });
        render(); renderHeader(); window.scrollTo && window.scrollTo(0, 0);
      } catch (e) { formErr(f, e.message); }
    },
    async found(f) {
      const v = readForm(f), staff = f.dataset.staff === "1";
      try {
        ui.foundResult = await store.createFoundItem(ui.token, { title: v.title, category: v.category, gate: v.gate, foundAt: parseLocal(v.foundAt), tags: v.tags, description: v.description, secret: v.secret, photo: ui.photo, website: v.website });
        ui.photo = null;
        if (store.storageError) toast("Saved, but browser storage is full. Photos may not persist.", true);
        if (store.notice) { toast(store.notice, true); store.notice = null; }
        render(); renderHeader(); window.scrollTo && window.scrollTo(0, 0);
      } catch (e) { formErr(f, e.message); }
    },
    async receiveCode(f) {
      const v = readForm(f);
      try {
        const r = await store.receiveItem(ui.token, v.code);
        toast(`${r.item.title} confirmed${r.alerts ? ` · ${r.alerts} owner alert${r.alerts === 1 ? "" : "s"} sent` : ""}`); render();
      } catch (e) { toast(e.message, true); }
    },
  };

  /* ---------- photo ---------- */
  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const s = Math.min(1, (REMOTE ? 1280 : 560) / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/jpeg", REMOTE ? 0.82 : 0.7));
        };
        img.onerror = reject; img.src = fr.result;
      };
      fr.onerror = reject; fr.readAsDataURL(file);
    });
  }

  /* ---------- wiring ---------- */
  function wire() {
    document.addEventListener("click", (e) => {
      const el = e.target.closest && e.target.closest("[data-act]");
      if (!el) { if (ui.suggest.length && !(e.target.closest && e.target.closest(".searchbox"))) { ui.suggest = []; refreshSearch(); } return; }
      if (el.dataset.act === "scrim" && e.target !== el) return; // clicks inside the modal (e.g. its submit button) must not be cancelled by the backdrop handler
      const fn = actions[el.dataset.act];
      if (fn) { if (el.tagName !== "INPUT") e.preventDefault(); fn(el, e); }
    });
    document.addEventListener("submit", (e) => {
      const f = e.target.closest && e.target.closest("form[data-form]");
      if (!f) return;
      e.preventDefault();
      forms[f.dataset.form](f);
    });
    document.addEventListener("input", (e) => {
      const t = e.target;
      if (t.id === "q") { ui.q = t.value; updateSuggest(); refreshSearch(); }
      else if (t.id === "ret") { const l = $("#retv"); if (l) l.textContent = t.value + " days"; }
    });
    document.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.set) { ui[t.dataset.set] = t.value; if (ui.view === "search") refreshSearch(); else render(); }
      else if (t.dataset && t.dataset.change === "retention") guard(() => { store.setRetention(ui.token, t.value); render(); })();
      else if (t.dataset && t.dataset.change === "auditItem") { ui.auditItem = t.value; render(); }
      else if (t.id === "photo" && t.files && t.files[0]) {
        readPhoto(t.files[0]).then((d) => { ui.photo = d; const p = $("#photoPrev"); if (p) p.innerHTML = `<img src="${d}" alt="Photo preview" style="max-width:160px;border-radius:8px;border:1px solid var(--line)">`; }, () => toast("That photo could not be read. Try another.", true));
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { if (ui.modal) { ui.modal = null; render(); } else if (ui.suggest.length) { ui.suggest = []; refreshSearch(); } return; }
      if (e.target && e.target.id === "q" && ui.suggest.length) {
        if (e.key === "ArrowDown") { e.preventDefault(); ui.sugIdx = (ui.sugIdx + 1) % ui.suggest.length; refreshSearch(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); ui.sugIdx = (ui.sugIdx - 1 + ui.suggest.length) % ui.suggest.length; refreshSearch(); }
        else if (e.key === "Enter" && ui.sugIdx >= 0) { e.preventDefault(); actions.pickSuggest({ dataset: { v: ui.suggest[ui.sugIdx] } }); }
      }
    });
    window.addEventListener("hashchange", () => {
      const v = (location.hash || "").replace("#", "");
      if (VIEWS.includes(v) && v !== ui.view) { ui.view = v; ui.modal = null; render(); }
    });
  }

  globalThis.__findr = { store, ui, actions, forms, views, render, go, runSearch, remote: REMOTE };
  if (typeof document !== "undefined" && document.addEventListener) {
    const start = (typeof location !== "undefined" ? (location.hash || "").replace("#", "") : "");
    if (VIEWS.includes(start)) ui.view = start;
    wire();
    if (REMOTE) {
      const app = $("#app");
      if (app) app.innerHTML = `<main class="wrap"><section class="head"><h1>FINDr</h1><p class="muted">Connecting…</p></section></main>`;
      store.init().then(() => { if (store.profile) ui.token = store.profile.token; }, (e) => { ui.loadError = e.message; })
        .then(() => { render(); if (ui.loadError) toast("Could not reach the server: " + ui.loadError, true); });
    } else {
      store.sweepRetention();
      render();
    }
  }
})();
