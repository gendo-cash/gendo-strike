// The owner's mandate and the checks every order passes before it reaches Strike. Pure functions:
// given the mandate, the account as Strike reports it and the order, say yes or say exactly why not.

export type Mandate = {
  /** Markets the agent may trade, e.g. ["BTC-USD", "ETH-USD"]. */
  markets: string[];
  /** Highest leverage the agent may use on any position. */
  maxLeverage: number;
  /** Largest position in one market, in USD notional (size × mark price). */
  maxPositionUsd: number;
  /** Largest sum of all positions' notional, in USD. */
  maxExposureUsd: number;
  /** Loss from the day's starting equity at which the guard closes everything and stops trading. */
  maxDailyLossUsd: number;
  /** Most new orders (opens and increases) in any 60 seconds. Closing is never limited. */
  maxOrdersPerMinute: number;
};

export const EXAMPLE_MANDATE: Mandate = {
  markets: ["BTC-USD", "ETH-USD", "ADA-USD", "SOL-USD"],
  maxLeverage: 5,
  maxPositionUsd: 500,
  maxExposureUsd: 1000,
  maxDailyLossUsd: 100,
  maxOrdersPerMinute: 6,
};

export function mandateProblems(m: Mandate): string[] {
  const p: string[] = [];
  if (!Array.isArray(m.markets) || m.markets.length === 0) p.push("list at least one market");
  for (const [k, v] of Object.entries({ maxLeverage: m.maxLeverage, maxPositionUsd: m.maxPositionUsd, maxExposureUsd: m.maxExposureUsd, maxDailyLossUsd: m.maxDailyLossUsd, maxOrdersPerMinute: m.maxOrdersPerMinute }))
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) p.push(`${k} must be a number above 0`);
  if (m.maxPositionUsd > m.maxExposureUsd) p.push("maxPositionUsd can't be above maxExposureUsd");
  return p;
}

export type Book = {
  /** Open positions: signed size (long > 0, short < 0) and the current mark price. */
  positions: { symbol: string; size: number; mark: number }[];
  /** Times (ms) of recent opening orders, for the rate limit. */
  recentOrdersMs: number[];
  /** Set once the daily loss limit was hit, or the owner pressed stop. */
  locked?: string;
};

export type Intent = { symbol: string; side: "buy" | "sell"; notionalUsd: number; leverage: number };
export type Verdict = { ok: true; size: number } | { ok: false; code: string; reason: string };

const notional = (size: number, mark: number) => Math.abs(size) * mark;

/** Round down to the market's step; never up, so a check on the rounded size still holds. */
export function sizeFor(notionalUsd: number, mark: number, stepSize: number): number {
  const raw = notionalUsd / mark;
  const steps = Math.floor(raw / stepSize + 1e-9);
  return Number((steps * stepSize).toFixed(10));
}

/**
 * May this order go out? An order that only shrinks or closes a position is always allowed, even when
 * locked: the guard must never stop an agent from reducing risk. Everything else is checked against the mandate.
 */
export function check(m: Mandate, book: Book, i: Intent, market: { mark: number; stepSize: number; minQty: number; minNotional: number }, nowMs: number): Verdict {
  const cur = book.positions.find((p) => p.symbol === i.symbol)?.size ?? 0;
  const size = sizeFor(i.notionalUsd, market.mark, market.stepSize);
  const signed = i.side === "buy" ? size : -size;
  const after = cur + signed;
  const reduces = cur !== 0 && Math.sign(signed) !== Math.sign(cur) && Math.abs(signed) <= Math.abs(cur);
  if (!(i.notionalUsd > 0)) return { ok: false, code: "SIZE", reason: "the order needs a size above 0 USD" };
  const tooSmall = size < market.minQty || size * market.mark < market.minNotional;
  const small: Verdict = { ok: false, code: "TOO_SMALL", reason: `below Strike's minimum for ${i.symbol} (${market.minQty} units and ${market.minNotional} USD)` };
  if (reduces) return tooSmall ? small : { ok: true, size };

  // The owner's rules come first: the agent should learn which rule it broke before any sizing detail.
  if (book.locked) return { ok: false, code: "LOCKED", reason: `trading is stopped: ${book.locked}. Only closing or reducing positions is allowed.` };
  if (!m.markets.includes(i.symbol)) return { ok: false, code: "MARKET", reason: `${i.symbol} isn't in the mandate. Allowed: ${m.markets.join(", ")}` };
  if (!(i.leverage >= 1) || i.leverage > m.maxLeverage)
    return { ok: false, code: "LEVERAGE", reason: `leverage ${i.leverage}x is outside the mandate (1x to ${m.maxLeverage}x)` };
  if (tooSmall) return small;
  const posAfter = notional(after, market.mark);
  if (posAfter > m.maxPositionUsd)
    return { ok: false, code: "POSITION", reason: `the ${i.symbol} position would be ${posAfter.toFixed(2)} USD; the mandate allows ${m.maxPositionUsd} USD per market` };
  const others = book.positions.filter((p) => p.symbol !== i.symbol).reduce((s, p) => s + notional(p.size, p.mark), 0);
  if (others + posAfter > m.maxExposureUsd)
    return { ok: false, code: "EXPOSURE", reason: `total exposure would be ${(others + posAfter).toFixed(2)} USD; the mandate allows ${m.maxExposureUsd} USD` };
  const recent = book.recentOrdersMs.filter((t) => nowMs - t < 60_000).length;
  if (recent >= m.maxOrdersPerMinute) return { ok: false, code: "RATE", reason: `${recent} orders in the last minute; the mandate allows ${m.maxOrdersPerMinute}` };
  return { ok: true, size };
}

/** Has the day's loss reached the limit? `startEquity` is the equity when the day (UTC) began. */
export function lossBreached(m: Mandate, startEquity: number, equity: number): boolean {
  return startEquity - equity >= m.maxDailyLossUsd;
}

/** What the order book offers near the price: the spread, and how much USD rests within 1% of mid on each side. */
export function liquidity(book: { bids: [number, number][]; asks: [number, number][] }) {
  const bid = book.bids[0]?.[0], ask = book.asks[0]?.[0];
  if (bid === undefined || ask === undefined) return { spreadPct: null, bidUsdWithin1Pct: 0, askUsdWithin1Pct: 0, note: "one side of the book is empty: market orders won't fill" };
  const mid = (bid + ask) / 2;
  const within = (side: [number, number][], ok: (p: number) => boolean) => side.filter(([p]) => ok(p)).reduce((s, [p, q]) => s + p * q, 0);
  return {
    spreadPct: ((ask - bid) / mid) * 100,
    bidUsdWithin1Pct: within(book.bids, (p) => p >= mid * 0.99),
    askUsdWithin1Pct: within(book.asks, (p) => p <= mid * 1.01),
  };
}
