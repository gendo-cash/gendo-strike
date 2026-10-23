// Live smoke test on a real Strike testnet account: an MCP client starts the guard (with STRIKE_API_KEY from
// the environment), opens a small ETH position, gets refused three times, sees an unfilled order, closes, and checks the account after each step.
//   set -a; source .env; set +a; node scripts/live-smoke.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.STRIKE_API_KEY) throw new Error("STRIKE_API_KEY is required (a Strike testnet API wallet key)");
const here = new URL("..", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "gendo-strike-live-"));
writeFileSync(join(home, "mandate.json"), JSON.stringify({ markets: ["ETH-USD", "SOL-USD", "ADA-USD"], maxLeverage: 3, maxPositionUsd: 20, maxExposureUsd: 30, maxDailyLossUsd: 5, maxOrdersPerMinute: 6 }));
const c = new Client({ name: "live-smoke", version: "0" });
await c.connect(new StdioClientTransport({ command: `${here}bin/gendo-strike`, args: ["--home", home, "--port", "18799"], env: { ...process.env, STRIKE_NETWORK: "testnet" } }));
const call = async (name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const step = (ok, what, detail) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
try {
  const m = await call("get_mandate");
  step(/live account/.test(m.venue), "the guard runs on the live Strike testnet account", m.venue);
  const a0 = await call("get_account");
  step(a0.equity_usd > 5, "reads the account's equity from Strike", `${a0.equity_usd} USD`);
  if (a0.positions.length) throw new Error(`the account already has open positions (${a0.positions.map((p) => p.symbol).join(", ")}): this test closes what it opens, so run it on an account with none`);

  const o = await call("open_position", { symbol: "ETH-USD", side: "long", notional_usd: 15, leverage: 2, reason: "live smoke test: a small ETH long" });
  step(o.status === "filled", "opens a 15 USD ETH long at 2x on Strike, and waits for the fill", JSON.stringify(o));
  let a1;
  for (let i = 0; i < 10; i++) {
    a1 = await call("get_account");
    if (a1.positions.some((p) => p.symbol === "ETH-USD")) break;
    await sleep(1000);
  }
  step(a1.positions.some((p) => p.symbol === "ETH-USD" && p.side === "long"), "Strike reports the position", JSON.stringify(a1.positions));

  const r1 = await call("open_position", { symbol: "ETH-USD", side: "long", notional_usd: 15, leverage: 2, reason: "over the per-market cap" });
  step(r1.status === "refused" && r1.code === "POSITION", "refuses adding past the per-market cap", r1.message);
  const r2 = await call("open_position", { symbol: "SOL-USD", side: "long", notional_usd: 15, leverage: 10, reason: "over the leverage cap" });
  step(r2.status === "refused" && r2.code === "LEVERAGE", "refuses leverage over the cap", r2.message);
  const r3 = await call("open_position", { symbol: "BTC-USD", side: "long", notional_usd: 15, leverage: 2, reason: "not in the mandate" });
  step(r3.status === "refused" && r3.code === "MARKET", "refuses a market outside the mandate", r3.message);
  const r4 = await call("open_position", { symbol: "ADA-USD", side: "long", notional_usd: 10, leverage: 2, reason: "a market with no sellers on testnet" });
  step(r4.status === "not_filled", "says so when Strike cancels an order for lack of liquidity", r4.message);

  const cl = await call("close_position", { symbol: "ETH-USD", reason: "live smoke test: close" });
  step(cl.status === "closed", "closes the position on Strike", JSON.stringify(cl));
  let a2;
  for (let i = 0; i < 10; i++) {
    a2 = await call("get_account");
    if (!a2.positions.some((p) => p.symbol === "ETH-USD")) break;
    await sleep(1000);
  }
  step(!a2.positions.some((p) => p.symbol === "ETH-USD"), "Strike reports it closed", `equity ${a2.equity_usd} USD`);
} finally {
  await c.close();
}
console.log(failed ? `FAILED: ${failed}` : "PASS");
process.exit(failed ? 1 : 0);
