// The owner's dashboard: a local page (127.0.0.1 only) showing the mandate, the account, every decision
// the guard made with the agent's own reasons, and a stop button. Anyone at the page may stop trading;
// only the owner's token resumes it, so an agent with a web-fetch tool can't unlock itself.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Guard } from "./guard.ts";

// Strike's own logo, served next to the page.
const STRIKE_LOGO = readFileSync(new URL("../assets/strike-logo.png", import.meta.url));
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startDashboard(guard: Guard, port: number, ownerToken: string) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY" });
      res.end(body);
    };
    try {
      if (req.method === "GET" && url.pathname === "/") return send(200, "text/html; charset=utf-8", PAGE);
      if (req.method === "GET" && url.pathname === "/strike-logo.png") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        return res.end(STRIKE_LOGO);
      }
      if (req.method === "GET" && url.pathname === "/api/state") return send(200, "application/json", JSON.stringify(await guard.snapshot()));
      if (req.method === "POST" && url.pathname === "/api/stop") {
        await guard.kill("stopped by the owner");
        return send(200, "application/json", JSON.stringify({ ok: true }));
      }
      if (req.method === "POST" && url.pathname === "/api/resume") {
        if (!same(req.headers["x-owner-token"]?.toString() ?? "", ownerToken)) return send(403, "application/json", JSON.stringify({ error: "only the owner can resume trading" }));
        guard.resume();
        return send(200, "application/json", JSON.stringify({ ok: true }));
      }
      send(404, "text/plain", "not found");
    } catch (e) {
      send(502, "application/json", JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gendo Guard for Strike</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 26 26'%3E%3Ccircle cx='13' cy='13' r='12' fill='%230d0b09' stroke='%23efe7d8' stroke-width='2'/%3E%3Cpath d='M13 1a12 12 0 0 1 0 24z' fill='%23e0452b'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap">
<style>
:root{--ink:#0d0b09;--ink2:#15120f;--ink3:#1a1612;--line:#2a241e;--paper:#efe7d8;--soft:#b9afa0;--mute:#8f8578;--red:#e0452b;--green:#7fb069}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--paper);font:14px/1.45 "Zen Kaku Gothic New",system-ui,sans-serif}
.mono{font-variant-numeric:tabular-nums}
.band{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;padding:5px 16px;font-size:12px;color:var(--soft);background:repeating-linear-gradient(-45deg,#15120f 0 10px,#1a1612 10px 20px);border-bottom:1px solid var(--line)}
.band b{color:var(--paper)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;font-weight:900;font-size:16px}.brand .x{color:var(--mute);font-weight:400;font-size:18px}.brand img{height:20px;width:auto;display:block}
.pill{height:38px;display:inline-flex;align-items:center;font-size:11px;letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--line);border-radius:999px;padding:0 14px;color:var(--soft)}
.pill.live{border-color:var(--green);color:var(--green)}.pill.stop{background:var(--red);border-color:var(--red);color:var(--ink);font-weight:700}
main{max-width:1180px;margin:0 auto;padding:18px 16px 40px;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr))}
.card{background:#110f0c;border:1px solid var(--line);border-radius:10px;overflow:hidden}.card.wide{grid-column:1/-1}
.ph{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line)}
.cap{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.body{padding:14px}.big{font-size:28px;font-weight:900}.pos{color:var(--green)}.neg{color:var(--red)}
.meter{height:8px;border-radius:99px;background:var(--ink3);overflow:hidden;margin:6px 0 2px}.meter i{display:block;height:100%;background:var(--soft)}.meter i.hot{background:var(--red)}
.row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line)}.row:last-child{border:0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px}th{color:var(--mute);font-weight:500;font-size:12px}th.n,td.n{text-align:right}td.mono{font-variant-numeric:tabular-nums}th:first-child,td:first-child{padding-left:14px}th:last-child,td:last-child{padding-right:14px}
.btn{height:38px;display:inline-flex;align-items:center;font:inherit;font-weight:700;border-radius:8px;padding:0 16px;cursor:pointer;border:1px solid var(--paper);background:var(--paper);color:var(--ink)}
.btn.stop{background:var(--red);border-color:var(--red);color:var(--ink)}.btn.ghost{background:none;color:var(--paper)}.btn[disabled]{opacity:.4;cursor:default}
.j{display:grid;grid-template-columns:84px 96px 1fr;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px}
.k{font-size:11px;line-height:1;text-transform:uppercase;letter-spacing:.06em;border-radius:5px;padding:5px 0;width:84px;text-align:center;justify-self:start;border:1px solid var(--line)}.rule{color:var(--soft)}
.k.order{color:var(--green);border-color:#3c5a2e}.k.close{color:var(--soft)}.k.refused{color:var(--red);border-color:#4a2a24}.k.stop{background:var(--red);color:var(--ink);border-color:var(--red)}.k.resume{color:var(--paper)}.k.error,.k.unfilled{color:#e0a52b;border-color:#4a3a1e}
.why{color:var(--soft);font-style:italic}.empty{color:var(--mute);padding:14px}
.banner{grid-column:1/-1;border:1px solid var(--red);background:#2a1410;border-radius:10px;padding:12px 14px;display:none}
@media (max-width:600px){.j{grid-template-columns:1fr}}
</style></head><body>
<div class="band"><b>Gendo Guard</b><span>Your AI trades Strike perpetuals inside the mandate you set. It never holds the key.</span></div>
<header>
  <div class="brand"><svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="none" stroke="#efe7d8" stroke-width="2"/><path d="M13 1a12 12 0 0 1 0 24z" fill="#e0452b"/></svg>gendo<span class="x">×</span><img src="/strike-logo.png" alt="Strike"></div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span id="mode" class="pill">…</span><span id="status" class="pill">…</span>
  <button id="stop" class="btn stop">Stop trading</button><button id="resume" class="btn ghost" style="display:none">Resume</button></div>
</header>
<main>
  <div id="banner" class="banner"></div>
  <section class="card"><div class="ph"><span class="cap">Equity</span><span class="cap" id="updated"></span></div><div class="body">
    <div class="big mono" id="equity">—</div><div>Today: <span id="pnl" class="mono">—</span></div>
    <div style="margin-top:12px" class="cap">Daily loss limit</div><div class="meter"><i id="lossbar"></i></div><div class="mono" style="font-size:12px;color:var(--soft)" id="losstext"></div>
    <div style="margin-top:12px" class="cap">Total exposure</div><div class="meter"><i id="expbar"></i></div><div class="mono" style="font-size:12px;color:var(--soft)" id="exptext"></div>
  </div></section>
  <section class="card"><div class="ph"><span class="cap">Mandate</span><span class="cap">set by you, read-only to the agent</span></div><div class="body" id="mandate"></div></section>
  <section class="card wide"><div class="ph"><span class="cap">Positions on Strike</span></div><div id="positions"></div></section>
  <section class="card wide"><div class="ph"><span class="cap">Every decision, with the agent's own reasons</span></div><div id="journal"></div></section>
</main>
<script>
const token = new URLSearchParams(location.search).get("owner") || "";
const $ = (id) => document.getElementById(id);
const usd = (n) => (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function render(s) {
  $("mode").textContent = s.mode === "strike" ? "Strike account" : "Paper, at Strike prices";
  $("mode").className = "pill" + (s.mode === "strike" ? " live" : "");
  $("status").textContent = s.locked ? "Stopped" : "Trading open";
  $("status").className = "pill" + (s.locked ? " stop" : " live");
  $("stop").disabled = !!s.locked;
  $("resume").style.display = s.locked && token ? "" : "none";
  $("banner").style.display = s.locked ? "block" : "none";
  $("banner").innerHTML = s.locked ? "<b>Trading is stopped:</b> " + esc(s.locked) + ". Positions were closed; the agent can only close, never open." + (token ? "" : " Open this page with your owner link to resume.") : "";
  $("equity").textContent = usd(s.equity);
  $("pnl").textContent = usd(s.dayPnl); $("pnl").className = "mono " + (s.dayPnl >= 0 ? "pos" : "neg");
  const m = s.mandate, lost = Math.max(0, -s.dayPnl), lp = Math.min(100, (lost / m.maxDailyLossUsd) * 100), ep = Math.min(100, (s.exposureUsd / m.maxExposureUsd) * 100);
  $("lossbar").style.width = lp + "%"; $("lossbar").className = lp > 70 ? "hot" : "";
  $("losstext").textContent = usd(lost) + " of " + usd(m.maxDailyLossUsd) + " lost today";
  $("expbar").style.width = ep + "%"; $("expbar").className = ep > 85 ? "hot" : "";
  $("exptext").textContent = usd(s.exposureUsd) + " of " + usd(m.maxExposureUsd);
  $("mandate").innerHTML = [["Markets", m.markets.join(", ")], ["Max leverage", m.maxLeverage + "×"], ["Max per market", usd(m.maxPositionUsd)], ["Max total exposure", usd(m.maxExposureUsd)], ["Daily loss stop", usd(m.maxDailyLossUsd)], ["Orders per minute", m.maxOrdersPerMinute]]
    .map(([k, v]) => '<div class="row"><span>' + k + '</span><b class="mono">' + esc(v) + "</b></div>").join("");
  $("positions").innerHTML = s.positions.length ? "<table><tr><th>Market</th><th>Side</th><th class=n>Size</th><th class=n>Entry</th><th class=n>Mark</th><th class=n>Notional</th><th class=n>Lev.</th><th class=n>Unrealized</th></tr>" +
    s.positions.map((p) => "<tr><td><b>" + esc(p.symbol) + "</b></td><td class='" + (p.side === "long" ? "pos" : "neg") + "'>" + p.side + "</td><td class='n mono'>" + p.size + "</td><td class='n mono'>" + p.entryPrice.toFixed(2) + "</td><td class='n mono'>" + p.mark.toFixed(2) + "</td><td class='n mono'>" + usd(p.notionalUsd) + "</td><td class='n mono'>" + p.leverage + "×</td><td class='n mono " + (p.upnl >= 0 ? "pos" : "neg") + "'>" + usd(p.upnl) + "</td></tr>").join("") + "</table>"
    : '<div class="empty">No open positions.</div>';
  const RULE = { LOCKED: "Trading is stopped", MARKET: "Market not allowed", LEVERAGE: "Leverage cap", POSITION: "Per-market cap", EXPOSURE: "Total exposure cap", RATE: "Order rate", TOO_SMALL: "Below Strike's minimum", SIZE: "Size" };
  $("journal").innerHTML = s.journal.length ? s.journal.map((e) => {
    const what = e.kind === "order" ? (e.side === "buy" ? "Long " : "Short ") + esc(e.symbol) + " " + usd(e.notionalUsd) + " at " + e.leverage + "×"
      : e.kind === "refused" ? "Refused " + (e.side === "buy" ? "long " : "short ") + esc(e.symbol) + " " + usd(e.notionalUsd || 0) + " at " + e.leverage + "×" + '<div class="rule"><b>' + esc(RULE[e.code] || e.code) + "</b>: " + esc(e.detail) + "</div>"
      : e.kind === "unfilled" ? "Not filled: " + (e.side ? (e.side === "buy" ? "long " : "short ") : "close ") + esc(e.symbol) + '<div class="rule">' + esc(e.detail) + "</div>" : e.kind === "close" ? "Closed " + esc(e.symbol) : e.kind === "stop" ? "Stopped: " + esc(e.detail) : e.kind === "resume" ? "Resumed by the owner" : "Error: " + esc(e.detail);
    return '<div class="j"><span class="mono" style="color:var(--mute)">' + t(e.at) + '</span><span class="k ' + e.kind + '">' + e.kind + "</span><span>" + what + (e.reason ? '<div class="why">“' + esc(e.reason) + '”</div>' : "") + "</span></div>";
  }).join("") : '<div class="empty">Nothing yet. Decisions appear here as the agent trades.</div>';
  $("updated").textContent = "updated " + t(Date.now());
}
async function load() { try { render(await (await fetch("/api/state")).json()); } catch {} }
$("stop").onclick = async () => { $("stop").disabled = true; await fetch("/api/stop", { method: "POST" }); load(); };
$("resume").onclick = async () => { const r = await fetch("/api/resume", { method: "POST", headers: { "x-owner-token": token } }); if (!r.ok) alert("Only the owner can resume."); load(); };
load(); setInterval(load, 3000);
</script></body></html>`;
