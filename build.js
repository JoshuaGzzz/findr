// Bundles dsa.js + store.js + app.js + style.css into one page.
// Outputs: findr.html (standalone, with doctype) and artifact.html (fragment for the Artifact tool).
const fs = require("fs");
const path = require("path");
const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const css = read("style.css");
const js = [read("dsa.js"), read("store.js"), read("supabase.js"), read("app.js")].join("\n;\n");
if (js.includes("</script")) throw new Error("bundle contains </script");
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap">';
const body = `<div id="app"></div><div id="toast" role="status" aria-live="polite"></div>\n<script>${js}</script>`;

// Optional Supabase mode: SUPABASE_URL + SUPABASE_KEY (publishable key) in the environment produce dist/index.html.
const SB_URL = process.env.SUPABASE_URL || "", SB_KEY = process.env.SUPABASE_KEY || "";
const SB_LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@" + require("./node_modules/@supabase/supabase-js/package.json").version + "/dist/umd/supabase.js";
if (SB_KEY.startsWith("sb_secret_") || /service_role/i.test(SB_KEY)) throw new Error("Refusing to build: SUPABASE_KEY must be the publishable/anon key, never a secret or service_role key.");
const frag = `<title>FINDr</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${fonts}\n<style>${css}</style>\n${body}\n`;
fs.writeFileSync(path.join(__dirname, "artifact.html"), frag);
fs.writeFileSync(path.join(__dirname, "findr.html"),
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>FINDr</title>\n${fonts}\n<style>${css}</style></head><body>${body}</body></html>\n`);
if (SB_URL && SB_KEY) {
  const cfg = `<script>window.FINDR_CONFIG=${JSON.stringify({ url: SB_URL, key: SB_KEY })};</script>\n<script src="${SB_LIB}"></script>`;
  const page = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>FINDr</title>\n${fonts}\n<style>${css}</style></head><body>${cfg}\n${body}</body></html>\n`;
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "dist", "index.html"), page);
  console.log("built dist/index.html with Supabase config");
} else {
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "findr.html"), path.join(__dirname, "dist", "index.html"));
  console.log("no SUPABASE_URL/SUPABASE_KEY set: dist/index.html is the browser-storage demo");
}
console.log("built", fs.statSync(path.join(__dirname, "findr.html")).size, "bytes");
