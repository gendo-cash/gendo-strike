import { describe, expect, it } from "vitest";
import { check, lossBreached, mandateProblems, sizeFor, type Book, type Mandate } from "../src/mandate.ts";

const m: Mandate = { markets: ["BTC-USD", "ETH-USD"], maxLeverage: 5, maxPositionUsd: 500, maxExposureUsd: 800, maxDailyLossUsd: 100, maxOrdersPerMinute: 3 };
const btc = { mark: 80_000, stepSize: 0.0001, minQty: 0.0001, minNotional: 5 };
const empty: Book = { positions: [], recentOrdersMs: [] };
const now = 1_800_000_000_000;

describe("the mandate", () => {
  it("lets an order inside every limit through, sized down to the market's step", () => {
    expect(check(m, empty, { symbol: "BTC-USD", side: "buy", notionalUsd: 200, leverage: 3 }, btc, now)).toEqual({ ok: true, size: 0.0025 });
  });
  it("refuses a market outside the mandate", () => {
    expect(check(m, empty, { symbol: "SOL-USD", side: "buy", notionalUsd: 50, leverage: 2 }, { ...btc, mark: 150 }, now)).toMatchObject({ ok: false, code: "MARKET" });
  });
  it("refuses leverage above the cap, and below 1x", () => {
    expect(check(m, empty, { symbol: "BTC-USD", side: "buy", notionalUsd: 100, leverage: 10 }, btc, now)).toMatchObject({ ok: false, code: "LEVERAGE" });
    expect(check(m, empty, { symbol: "BTC-USD", side: "buy", notionalUsd: 100, leverage: 0.5 }, btc, now)).toMatchObject({ ok: false, code: "LEVERAGE" });
  });
  it("counts the existing position: adding to it can't pass the per-market cap", () => {
    const book: Book = { positions: [{ symbol: "BTC-USD", size: 0.005, mark: 80_000 }], recentOrdersMs: [] }; // 400 USD long
    expect(check(m, book, { symbol: "BTC-USD", side: "buy", notionalUsd: 150, leverage: 2 }, btc, now)).toMatchObject({ ok: false, code: "POSITION" });
    expect(check(m, book, { symbol: "BTC-USD", side: "buy", notionalUsd: 90, leverage: 2 }, btc, now)).toMatchObject({ ok: true });
  });
  it("counts every market for total exposure", () => {
    const book: Book = { positions: [{ symbol: "ETH-USD", size: 0.15, mark: 3_000 }], recentOrdersMs: [] }; // 450 USD
    expect(check(m, book, { symbol: "BTC-USD", side: "sell", notionalUsd: 400, leverage: 2 }, btc, now)).toMatchObject({ ok: false, code: "EXPOSURE" });
  });
  it("a short that flips a long counts the new short, not the trade size", () => {
    const book: Book = { positions: [{ symbol: "BTC-USD", size: 0.001, mark: 80_000 }], recentOrdersMs: [] }; // 80 USD long
    // Selling 600 USD: ends 520 USD short, over the 500 USD per-market cap.
    expect(check(m, book, { symbol: "BTC-USD", side: "sell", notionalUsd: 600, leverage: 2 }, btc, now)).toMatchObject({ ok: false, code: "POSITION" });
  });
  it("closing or reducing is always allowed, even when locked and over every limit", () => {
    const book: Book = { positions: [{ symbol: "BTC-USD", size: 0.01, mark: 80_000 }], recentOrdersMs: [now, now, now], locked: "daily loss limit reached" };
    expect(check(m, book, { symbol: "BTC-USD", side: "sell", notionalUsd: 800, leverage: 50 }, btc, now)).toEqual({ ok: true, size: 0.01 });
  });
  it("when locked, nothing new opens", () => {
    expect(check(m, { ...empty, locked: "stopped by the owner" }, { symbol: "BTC-USD", side: "buy", notionalUsd: 50, leverage: 1 }, btc, now)).toMatchObject({ ok: false, code: "LOCKED" });
  });
  it("limits opening orders per minute", () => {
    const book: Book = { positions: [], recentOrdersMs: [now - 10_000, now - 20_000, now - 30_000] };
    expect(check(m, book, { symbol: "BTC-USD", side: "buy", notionalUsd: 50, leverage: 1 }, btc, now)).toMatchObject({ ok: false, code: "RATE" });
    expect(check(m, { ...book, recentOrdersMs: [now - 61_000, now - 62_000, now - 63_000] }, { symbol: "BTC-USD", side: "buy", notionalUsd: 50, leverage: 1 }, btc, now)).toMatchObject({ ok: true });
  });
  it("refuses an order below Strike's minimums", () => {
    expect(check(m, empty, { symbol: "BTC-USD", side: "buy", notionalUsd: 4, leverage: 1 }, btc, now)).toMatchObject({ ok: false, code: "TOO_SMALL" });
  });
  it("sizing never rounds up past the notional asked for", () => {
    expect(sizeFor(100, 3, 1)).toBe(33);
    expect(sizeFor(200, 80_000, 0.0001) * 80_000).toBeLessThanOrEqual(200);
  });
  it("the daily loss stop trips at the limit, not before", () => {
    expect(lossBreached(m, 1_000, 901)).toBe(false);
    expect(lossBreached(m, 1_000, 900)).toBe(true);
  });
  it("a mandate must be sane before the guard starts", () => {
    expect(mandateProblems(m)).toEqual([]);
    expect(mandateProblems({ ...m, markets: [], maxLeverage: 0, maxPositionUsd: 900 })).toEqual(["list at least one market", "maxLeverage must be a number above 0", "maxPositionUsd can't be above maxExposureUsd"]);
  });
});

describe("the order of refusals", () => {
  it("a stopped guard says so first, even for an order that is also too small", () => {
    const tiny = { mark: 80_000, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
    expect(check(m, { ...empty, locked: "stopped by the owner" }, { symbol: "BTC-USD", side: "buy", notionalUsd: 10, leverage: 1 }, tiny, now)).toMatchObject({ code: "LOCKED" });
  });
});
