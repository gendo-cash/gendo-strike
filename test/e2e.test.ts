// End to end: an MCP client starts gendo-strike the way an AI app does (stdio), on a paper account at
// Strike testnet's live mark prices, then drives the tools and the owner dashboard. Needs the network.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "gendo-strike-e2e-"));
const port = 18711 + Math.floor(Math.random() * 1000);
const dash = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init);
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text);
};

beforeAll(async () => {
  writeFileSync(join(home, "mandate.json"), JSON.stringify({ markets: ["BTC-USD", "ETH-USD"], maxLeverage: 3, maxPositionUsd: 300, maxExposureUsd: 500, maxDailyLossUsd: 50, maxOrdersPerMinute: 5 }));
  client = new Client({ name: "e2e", version: "0" });
  const env = { ...process.env, STRIKE_API_KEY: "" } as Record<string, string>;
  await client.connect(new StdioClientTransport({ command: join(import.meta.dirname, "../bin/gendo-strike"), args: ["--home", home, "--port", String(port)], env }));
}, 60_000);
afterAll(async () => client?.close());

describe("gendo-strike over MCP", () => {
  it("offers the agent trading tools and nothing that changes the rules", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["close_position", "get_account", "get_candles", "get_mandate", "get_market", "open_position"]);
  });
  it("reads the mandate, and Strike testnet market data: price, funding, open interest, the book, candles", async () => {
    expect(await call("get_mandate")).toMatchObject({ mandate: { maxLeverage: 3 }, trading: "open" });
    const mk = await call("get_market", { symbol: "ETH-USD" });
    expect(mk.mark_price).toBeGreaterThan(100);
    expect(typeof mk.funding_rate_pct).toBe("number");
    expect(mk.book).toHaveProperty("spread_pct");
    const c = await call("get_candles", { symbol: "ETH-USD", interval: "1h", limit: 5 });
    expect(c.candles.length).toBeGreaterThan(0);
    expect(c.candles[0]).toEqual(expect.objectContaining({ o: expect.any(Number), c: expect.any(Number) }));
  });
  it("opens a position inside the mandate", async () => {
    expect(await call("open_position", { symbol: "BTC-USD", side: "long", notional_usd: 200, leverage: 2, reason: "testing the guard" })).toMatchObject({ status: "filled" });
    const a = await call("get_account");
    expect(a.positions).toMatchObject([{ symbol: "BTC-USD", side: "long" }]);
    expect(a.room.exposure_left_usd).toBeLessThan(301);
  });
  it("refuses leverage over the cap and a market outside the mandate", async () => {
    expect(await call("open_position", { symbol: "ETH-USD", side: "short", notional_usd: 100, leverage: 10, reason: "too much" })).toMatchObject({ status: "refused", code: "LEVERAGE" });
    expect(await call("open_position", { symbol: "SOL-USD", side: "long", notional_usd: 100, leverage: 2, reason: "not allowed" })).toMatchObject({ status: "refused", code: "MARKET" });
  });
  it("the dashboard shows the journal; stop closes everything; only the owner's token resumes", async () => {
    const s = await (await dash("/api/state")).json();
    expect(s.journal.map((e: { kind: string }) => e.kind)).toEqual(["refused", "refused", "order"]);
    const page = await (await dash("/", {})).text();
    // The page's script must parse: a stray quote would blank the whole dashboard.
    expect(() => new Function(page.match(/<script>([\s\S]*)<\/script>/)![1]!)).not.toThrow();
    await dash("/api/stop", { method: "POST" });
    expect((await call("get_account")).positions).toEqual([]);
    expect(await call("open_position", { symbol: "BTC-USD", side: "long", notional_usd: 50, leverage: 1, reason: "after stop" })).toMatchObject({ code: "LOCKED" });
    expect((await dash("/api/resume", { method: "POST" })).status).toBe(403);
    expect((await dash("/api/resume", { method: "POST", headers: { "x-owner-token": "guess" } })).status).toBe(403);
    const token = readFileSync(join(home, "owner-token"), "utf8").trim();
    expect((await dash("/api/resume", { method: "POST", headers: { "x-owner-token": token } })).status).toBe(200);
    expect((await call("get_mandate")).trading).toBe("open");
  });
  it("only the owner edits the mandate from the dashboard; the agent sees the change at once", async () => {
    const token = readFileSync(join(home, "owner-token"), "utf8").trim();
    const next = { markets: ["BTC-USD", "ETH-USD", "SOL-USD"], maxLeverage: 2, maxPositionUsd: 250, maxExposureUsd: 400, maxDailyLossUsd: 40, maxOrdersPerMinute: 5 };
    const post = (body: unknown, t?: string) => dash("/api/mandate", { method: "POST", headers: { "content-type": "application/json", ...(t ? { "x-owner-token": t } : {}) }, body: JSON.stringify(body) });
    expect((await post(next)).status).toBe(403);
    const bad = await post({ ...next, maxPositionUsd: 900 }, token);
    expect(bad.status).toBe(400);
    expect((await bad.json()).problems).toEqual(["maxPositionUsd can't be above maxExposureUsd"]);
    expect((await post(next, token)).status).toBe(200);
    expect((await call("get_mandate")).mandate).toEqual(next);
    expect(JSON.parse(readFileSync(join(home, "mandate.json"), "utf8"))).toEqual(next);
    expect((await (await dash("/api/markets")).json()).markets).toContain("BTC-USD");
  });
  it("a second copy, as an AI app starts for another chat, trades through the first: one journal, one stop", async () => {
    const second = new Client({ name: "e2e-2", version: "0" });
    await second.connect(new StdioClientTransport({ command: join(import.meta.dirname, "../bin/gendo-strike"), args: ["--home", home, "--port", String(port)], env: { ...process.env, STRIKE_API_KEY: "" } as Record<string, string> }));
    try {
      const call2 = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await second.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);
      expect(await call2("open_position", { symbol: "ETH-USD", side: "long", notional_usd: 100, leverage: 2, reason: "from the second window" })).toMatchObject({ status: "filled" });
      const s = await (await dash("/api/state")).json();
      expect(s.journal[0]).toMatchObject({ kind: "order", reason: "from the second window" });
      await dash("/api/stop", { method: "POST" });
      expect(await call2("open_position", { symbol: "ETH-USD", side: "long", notional_usd: 100, leverage: 2, reason: "after the stop" })).toMatchObject({ code: "LOCKED" });
      expect((await (await dash("/api/agent/trade", { method: "POST", body: "{}" })).status)).toBe(403); // only a guard copy may forward
    } finally {
      await second.close();
    }
  });
});
