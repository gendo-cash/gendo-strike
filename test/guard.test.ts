import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PaperBroker } from "../src/broker.ts";
import { Guard } from "../src/guard.ts";
import type { Mandate } from "../src/mandate.ts";

const m: Mandate = { markets: ["BTC-USD", "ETH-USD"], maxLeverage: 5, maxPositionUsd: 500, maxExposureUsd: 800, maxDailyLossUsd: 100, maxOrdersPerMinute: 10 };
const feed = (prices: Record<string, number>) => ({
  markPrice: async (s: string) => prices[s]!,
  market: async (s: string) => (s in prices ? { symbol: s, stepSize: 0.0001, minQty: 0.0001, maxQty: 1e9, minNotional: 5 } : undefined),
});
const setup = (prices: Record<string, number>, journal?: string) => {
  const broker = new PaperBroker(feed(prices), 1_000);
  return { prices, broker, guard: new Guard(broker, m, journal) };
};

describe("the guard", () => {
  it("places an order inside the mandate and journals it with the agent's reason", async () => {
    const { guard } = setup({ "BTC-USD": 80_000 });
    expect(await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 200, leverage: 3, reason: "breakout above 80k" })).toMatchObject({ status: "filled", size: 0.0025 });
    const s = await guard.snapshot();
    expect(s.positions).toMatchObject([{ symbol: "BTC-USD", side: "long", size: 0.0025 }]);
    expect(s.journal[0]).toMatchObject({ kind: "order", reason: "breakout above 80k" });
  });
  it("refuses outside the mandate, says why, places nothing", async () => {
    const { guard, broker } = setup({ "BTC-USD": 80_000 });
    expect(await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 2_000, leverage: 3, reason: "all in" })).toMatchObject({ status: "refused", code: "POSITION" });
    expect(await broker.positions()).toEqual([]);
    expect((await guard.snapshot()).journal[0]).toMatchObject({ kind: "refused", code: "POSITION", reason: "all in" });
  });
  it("the daily loss stop closes everything, locks new trades, and still allows nothing but closing", async () => {
    const { guard, broker, prices } = setup({ "BTC-USD": 80_000, "ETH-USD": 3_000 });
    await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 480, leverage: 5, reason: "long" });
    prices["BTC-USD"] = 60_000; // -25%: about -120 USD on a 480 USD long
    const r = await guard.trade({ symbol: "ETH-USD", side: "buy", notionalUsd: 100, leverage: 2, reason: "buy the dip" });
    expect(r).toMatchObject({ status: "refused", code: "LOCKED" });
    expect(await broker.positions()).toEqual([]);
    const s = await guard.snapshot();
    expect(s.locked).toMatch(/daily loss limit reached/);
    expect(s.journal.map((e) => e.kind)).toEqual(expect.arrayContaining(["stop", "close", "refused"]));
  });
  it("the owner's stop closes everything; resume reopens trading", async () => {
    const { guard, broker } = setup({ "BTC-USD": 80_000 });
    await guard.trade({ symbol: "BTC-USD", side: "sell", notionalUsd: 300, leverage: 2, reason: "short" });
    await guard.kill();
    expect(await broker.positions()).toEqual([]);
    expect(await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 50, leverage: 1, reason: "x" })).toMatchObject({ code: "LOCKED" });
    guard.resume();
    expect(await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 50, leverage: 1, reason: "x" })).toMatchObject({ status: "filled" });
  });
  it("a stop survives a restart: only the owner lifts it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "gs-")), "journal.jsonl");
    await setup({ "BTC-USD": 80_000 }, path).guard.kill();
    const again = setup({ "BTC-USD": 80_000 }, path).guard;
    expect((await again.snapshot()).locked).toBe("stopped by the owner");
  });
  it("two orders at once can't both pass a check meant for one", async () => {
    const { guard } = setup({ "BTC-USD": 80_000 });
    const rs = await Promise.all([1, 2].map(() => guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 300, leverage: 2, reason: "race" })));
    expect(rs.map((r) => r.status).sort()).toEqual(["filled", "refused"]);
  });
  it("closing a position is allowed even when locked", async () => {
    const { guard, broker } = setup({ "BTC-USD": 80_000 });
    await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 100, leverage: 2, reason: "long" });
    await broker.order("BTC-USD", "buy", 0.001, 2, false); // the agent can't do this; it stands in for a position the stop missed
    await guard.kill();
    await broker.order("BTC-USD", "buy", 0.001, 2, false);
    expect(await guard.close("BTC-USD", "flatten")).toMatchObject({ status: "closed" });
  });
});

describe("the owner changes the mandate", () => {
  it("a valid change applies to the next order, is journaled, and is saved", async () => {
    const saved: Mandate[] = [];
    const broker = new PaperBroker(feed({ "BTC-USD": 80_000 }), 1_000);
    const guard = new Guard(broker, m, undefined, Date.now, (x) => saved.push(x));
    expect(guard.setMandate({ ...m, maxLeverage: 2 })).toEqual({ ok: true });
    expect(await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 100, leverage: 3, reason: "3x" })).toMatchObject({ code: "LEVERAGE" });
    expect(saved).toEqual([{ ...m, maxLeverage: 2 }]);
    expect((await guard.snapshot()).journal.find((e) => e.kind === "mandate")?.detail).toBe("max leverage 5× → 2×");
  });
  it("an invalid change is refused and nothing changes", async () => {
    const { guard } = setup({ "BTC-USD": 80_000 });
    expect(guard.setMandate({ ...m, maxPositionUsd: 5_000 })).toEqual({ ok: false, problems: ["maxPositionUsd can't be above maxExposureUsd"] });
    expect(guard.mandate).toEqual(m);
  });
});

describe("a stop that can't close everything at once", () => {
  it("says which positions are still open, and keeps trying until they close", async () => {
    const paper = new PaperBroker(feed({ "BTC-USD": 80_000 }), 1_000);
    let blocked = true; // the book has no buyers near the price
    const broker = Object.assign(Object.create(paper), {
      mode: paper.mode,
      order: async (s: string, side: "buy" | "sell", size: number, lev: number, reduce: boolean) =>
        reduce && blocked ? { id: "x", filled: 0, reason: "too little liquidity" } : paper.order(s, side, size, lev, reduce),
    });
    const guard = new Guard(broker, m);
    await guard.trade({ symbol: "BTC-USD", side: "buy", notionalUsd: 200, leverage: 2, reason: "long" });
    await guard.kill();
    const s1 = await guard.snapshot();
    expect(s1.locked).toBe("stopped by the owner");
    expect(s1.unclosed).toEqual(["BTC-USD"]);
    expect(s1.journal.filter((e) => e.kind === "unfilled")).toHaveLength(1);
    await guard.watch(); // still blocked: retried, and not journaled again
    expect((await guard.snapshot()).journal.filter((e) => e.kind === "unfilled")).toHaveLength(1);
    blocked = false;
    await guard.watch();
    const s2 = await guard.snapshot();
    expect(s2.positions).toEqual([]);
    expect(s2.unclosed).toEqual([]);
    expect(s2.journal[0]).toMatchObject({ kind: "close", symbol: "BTC-USD" });
  });
});
