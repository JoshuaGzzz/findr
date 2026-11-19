(async function () {
  const out = [];
  const log = (n, ok, m) => out.push((ok ? "ok   " : "FAIL ") + n + (m !== undefined ? "  [" + m + "]" : ""));
  window.addEventListener("error", (e) => out.push("FAIL uncaught: " + e.message));
  try {
    const F = __findr, st = F.store, $ = (s) => document.querySelector(s), $$ = (s) => document.querySelectorAll(s);
    const fake = (values, ds) => ({ __values: values, dataset: ds || {}, querySelector: () => null });
    const click = (act, ds) => F.actions[act](Object.assign({ dataset: Object.assign({}, ds), tagName: "BUTTON" }), { target: null });
    const txt = () => document.getElementById("app").textContent;

    for (const v of ["search", "report", "found", "activity", "desk", "intake", "cleanup", "audit"]) {
      F.ui.view = v; F.render(); log("guest renders " + v, $("#main").innerHTML.length > 50);
    }
    F.ui.view = "search"; F.render();
    log("seed shows all searchable items", $$("#results .ticket").length >= 9, $$("#results .ticket").length);
    const q = $("#q"); q.value = "umb"; q.dispatchEvent(new Event("input", { bubbles: true }));
    log("auto-complete offers suggestions", $$("#suggest li").length > 0, $$("#suggest li").length);
    log("prefix 'umb' finds 2 umbrellas", $$("#results .ticket").length === 2, $$("#results .ticket").length);
    log("identical items offer compare", txt().includes("Compare 1 similar"));
    q.value = "payong"; q.dispatchEvent(new Event("input", { bubbles: true }));
    log("Filipino synonym 'payong' works", $$("#results .ticket").length === 2);
    q.value = "umbrela"; q.dispatchEvent(new Event("input", { bubbles: true }));
    log("typo shows did-you-mean", txt().includes("Showing results for"));
    await click("clearFilters");

    // guest claim -> sign-in prompt
    const firstId = $$(".ticket .tid")[0].textContent;
    await click("openClaim", { id: firstId });
    log("guest claim opens sign-in", !!$(".modal") && txt().includes("Sign in to claim"));

    // sign in as Jamie, smart-match alert badge
    await F.forms.signin(fake({ name: "Jamie Cruz", studentId: "24-01234" }, { role: "student" }));
    log("student signed in", !!F.store.session(F.ui.token));
    log("alert badge in header", !!$("#hdr .count"), $("#hdr .count") && $("#hdr .count").textContent);
    F.go("activity");
    log("activity shows smart-match", txt().includes("Possible match"));
    log("badge cleared after viewing", !$("#hdr .count"));

    // wrong then right claim on the wallet (item with seeded secret)
    const wallet = st.search({ q: "wallet" }).results[0].item;
    F.ui.view = "search"; F.render();
    await F.forms.claim(fake({ id: wallet.id, details: "just a blue case", contact: "x" }));
    log("wrong claim does not move item", st.getItem(wallet.id).status === "CLAIM_PENDING" || st.getItem(wallet.id).status === "UNCLAIMED");
    const bottle = st.search({ q: "tumbler" }).results[0].item;
    await F.forms.claim(fake({ id: bottle.id, details: "blue dent at the bottom and a naruto stiker", contact: "jamie@school.edu" }));
    log("right claim -> Claim Pending", st.getItem(bottle.id).status === "CLAIM_PENDING");
    log("claim confirmation modal", txt().includes("Claim sent"));
    await F.actions.closeModal();

    // student reports a found item -> code
    F.ui.view = "found"; F.render();
    log("found form has honeypot", !!$('input[name="website"]'));
    await F.forms.found(fake({ title: "Red scarf", category: "clothing", gate: "g-main", foundAt: "", tags: "red", description: "left on bench", secret: "monogram JC", website: "" }, { staff: "0" }));
    log("found item returns drop-off code", !!$(".code") && $(".code").textContent.length === 5, $(".code") && $(".code").textContent);
    const code = $(".code").textContent;
    await F.forms.found(fake({ title: "Red scarf", category: "clothing", gate: "g-main", foundAt: "", tags: "red", description: "", secret: "", website: "bot" }, { staff: "0" }));
    log("search hides pending item", st.search({ q: "scarf" }).total === 0);

    // staff
    await F.actions.signout();
    await F.forms.signin(fake({ name: "Guard Reyes", pin: "2026" }, { role: "staff" }));
    log("staff lands on desk", F.ui.view === "desk" && txt().includes("Front desk"));
    log("desk lists pending + claim", txt().includes("Red scarf") && txt().includes("Claims to review") && txt().includes("Blue Hydro Flask"));
    await F.forms.receiveCode(fake({ code: code }));
    log("code confirms drop-off", st.search({ q: "scarf" }).total === 1);
    log("undo bar appears", txt().includes("Last change"));
    await click("undo");
    log("undo hides scarf again", st.search({ q: "scarf" }).total === 0);
    const claim = st.claimQueue().find((c) => c.item.id === bottle.id).claim;
    await click("approve", { id: claim.id });
    log("approve releases item", st.getItem(bottle.id).status === "CLAIMED");

    F.go("cleanup");
    log("cleanup ranks oldest first", /#1[\s\S]*?(House keys)/.test(txt()) && txt().includes("past the limit"));
    const before = st.dueCount();
    await click("processOldest", { d: "donated" });
    log("process oldest reduces due count", st.dueCount() === before - 1, before + "->" + st.dueCount());
    F.actions.go ? F.go("audit") : 0;
    log("audit log renders entries + under the hood", txt().includes("Claim approved") && txt().includes("Under the hood") && txt().includes("longest chain"));
    F.ui.auditItem = bottle.id; F.render();
    log("item history stack shows", txt().includes("State history"));
    F.go("intake");
    await F.forms.found(fake({ title: "Green umbrella", category: "umbrellas", gate: "g-lib", foundAt: "", tags: "green", description: "", secret: "bent tip", website: "" }, { staff: "1" }));
    log("staff intake goes straight to unclaimed", txt().includes("now unclaimed"));
  } catch (e) { out.push("FAIL exception: " + e.stack); }
  const pre = document.createElement("pre"); pre.id = "smoke"; pre.textContent = out.join("\n"); document.body.appendChild(pre);
})();
