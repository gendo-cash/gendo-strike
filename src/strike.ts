// Strike Finance V2 API client. Authenticated calls are signed with an Ed25519 "API wallet" key:
// Strike lets that key trade but never deposit or withdraw, so whoever holds it can't move funds out.
// Signature message: {METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{SHA256(BODY)} (docs: api/getting-started).
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";

export const STRIKE_HOSTS = {
  testnet: "https://api-v2-testnet.strikefinance.org",
  mainnet: "https://api.strikefinance.org",
} as const;
export type StrikeNetwork = keyof typeof STRIKE_HOSTS;

/** An Ed25519 key from Strike's raw hex formats: a 32-byte seed, or 64 bytes (seed + public key). */
export function apiKeyFromHex(privateHex: string): { key: KeyObject; publicHex: string } {
  const raw = Buffer.from(privateHex.trim(), "hex");
  if (raw.length !== 32 && raw.length !== 64) throw new Error("a Strike API private key is 64 or 128 hex characters");
  const seed = raw.subarray(0, 32);
  // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return { key, publicHex: Buffer.from(spki.subarray(spki.length - 32)).toString("hex") };
}

/** The four headers Strike checks on every authenticated request. */
export function signedHeaders(k: { key: KeyObject; publicHex: string }, method: string, path: string, body: string, nowS = Math.floor(Date.now() / 1000), nonce: string = randomUUID()) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const message = `${method.toUpperCase()}:${path}:${nowS}:${nonce}:${bodyHash}`;
  return {
    "X-API-Wallet-Public-Key": k.publicHex,
    "X-API-Wallet-Signature": sign(null, Buffer.from(message), k.key).toString("hex"),
    "X-API-Wallet-Timestamp": String(nowS),
    "X-API-Wallet-Nonce": nonce,
  };
}

export type Candle = { openTime: number; open: number; high: number; low: number; close: number; volume: number };
export type Market = { symbol: string; minQty: number; stepSize: number; maxQty: number; minNotional: number };
export type Position = { symbol: string; size: number; entryPrice: number; leverage: number; upnl: number; liquidationPrice: number };
export type Account = { walletBalance: number; marginBalance: number; availableBalance: number; unrealizedPnl: number };
export type OrderRequest = { symbol: string; side: "buy" | "sell"; size: string; reduceOnly?: boolean; clientOrderId?: string };

export class StrikeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const num = (x: unknown) => Number(x ?? 0);

export class StrikeClient {
  readonly host: string;
  private markets?: Map<string, Market>;
  constructor(readonly network: StrikeNetwork, private readonly auth?: { key: KeyObject; publicHex: string }) {
    this.host = STRIKE_HOSTS[network];
  }

  private async call<T>(method: string, path: string, body?: unknown, authed = true): Promise<T> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
    if (authed) {
      if (!this.auth) throw new StrikeError(0, "no Strike API key configured");
      Object.assign(headers, signedHeaders(this.auth, method, path, text));
    }
    const r = await fetch(this.host + path, { method, headers, ...(body === undefined ? {} : { body: text }), signal: AbortSignal.timeout(15_000) });
    const raw = await r.text();
    let j: unknown;
    try {
      j = raw ? JSON.parse(raw) : {};
    } catch {
      j = { error: raw.slice(0, 300) };
    }
    if (!r.ok) {
      const e = j as { error?: string; msg?: string; message?: string };
      throw new StrikeError(r.status, e.error ?? e.msg ?? e.message ?? `Strike answered ${r.status}`);
    }
    return j as T;
  }

  // --- public market data (no key) -------------------------------------------

  async market(symbol: string): Promise<Market | undefined> {
    if (!this.markets) {
      type F = { filterType: string; minQty?: string; maxQty?: string; stepSize?: string; notional?: string };
      const info = await this.call<{ symbols: { symbol: string; status: string; filters: F[] }[] }>("GET", "/price/v2/exchangeInfo", undefined, false);
      this.markets = new Map(
        info.symbols.filter((s) => s.status === "trading").map((s) => {
          const lot = s.filters.find((f) => f.filterType === "MARKET_LOT_SIZE") ?? s.filters.find((f) => f.filterType === "LOT_SIZE");
          const mn = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
          return [s.symbol, { symbol: s.symbol, minQty: num(lot?.minQty), stepSize: num(lot?.stepSize) || 1e-8, maxQty: num(lot?.maxQty) || Infinity, minNotional: num(mn?.notional) }];
        }),
      );
    }
    return this.markets.get(symbol);
  }

  async symbols(): Promise<string[]> {
    await this.market("");
    return [...this.markets!.keys()];
  }

  async markPrice(symbol: string): Promise<number> {
    const p = await this.call<{ p?: string; markPrice?: string }>("GET", `/price/v2/markPrice?symbol=${encodeURIComponent(symbol)}`, undefined, false);
    const v = num(p.p ?? p.markPrice);
    if (!(v > 0)) throw new StrikeError(0, `no mark price for ${symbol}`);
    return v;
  }

  /** Candles, oldest first. Interval as Strike names them: 1m, 5m, 15m, 1h, 4h, 1d... */
  async candles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const q = `symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(Math.max(1, Math.floor(limit)), 500)}`;
    const rows = await this.call<unknown[][]>("GET", `/price/v2/klines?${q}`, undefined, false);
    return rows.map((r) => ({ openTime: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]) }));
  }

  /** Funding: the rate longs pay shorts (negative: shorts pay longs) at the next funding time. */
  async funding(symbol: string): Promise<{ markPrice: number; indexPrice: number; fundingRate: number; nextFundingTime: number }> {
    const f = await this.call<Record<string, unknown>>("GET", `/price/v2/premiumIndex?symbol=${encodeURIComponent(symbol)}`, undefined, false);
    return { markPrice: num(f.markPrice), indexPrice: num(f.indexPrice), fundingRate: num(f.fundingRate), nextFundingTime: num(f.nextFundingTime) };
  }

  async openInterest(symbol: string): Promise<number> {
    return num((await this.call<Record<string, unknown>>("GET", `/price/v2/openInterest?symbol=${encodeURIComponent(symbol)}`, undefined, false)).openInterest);
  }

  async book(symbol: string, limit = 20): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    const d = await this.call<{ bids?: string[][]; asks?: string[][] }>("GET", `/price/v2/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`, undefined, false);
    const side = (x?: string[][]) => (x ?? []).map((l) => [num(l[0]), num(l[1])] as [number, number]);
    return { bids: side(d.bids), asks: side(d.asks) };
  }

  // --- the account behind the API key ----------------------------------------

  async account(): Promise<Account> {
    const a = await this.call<Record<string, unknown>>("GET", "/v2/account");
    return { walletBalance: num(a.wallet_balance), marginBalance: num(a.margin_balance), availableBalance: num(a.available_balance), unrealizedPnl: num(a.unrealized_pnl) };
  }

  async positions(): Promise<Position[]> {
    const r = await this.call<{ positions?: Record<string, unknown>[] }>("GET", "/v2/positions");
    return (r.positions ?? [])
      .map((p) => ({ symbol: String(p.symbol), size: num(p.size), entryPrice: num(p.entry_price), leverage: num(p.leverage), upnl: num(p.upnl), liquidationPrice: num(p.liquidation_price) }))
      .filter((p) => p.size !== 0);
  }

  setLeverage(symbol: string, leverage: number) {
    return this.call("POST", "/v2/leverage", { symbol, leverage });
  }

  /** Market orders only: the guard sizes every order from the mark price it just checked. */
  placeMarket(o: OrderRequest) {
    return this.call<Record<string, unknown>>("POST", "/v2/order", {
      symbol: o.symbol, side: o.side, type: "market", size: o.size,
      ...(o.reduceOnly ? { reduce_only: true } : {}), ...(o.clientOrderId ? { client_order_id: o.clientOrderId } : {}),
    });
  }

  cancelAll() {
    return this.call("DELETE", "/v2/order/cancel-all", {});
  }

  /** An order's current state, by the id we gave it. Strike answers both snake_case and PascalCase. */
  async orderState(symbol: string, clientOrderId: string): Promise<OrderState | undefined> {
    const o = await this.call<Record<string, unknown>>("GET", `/v2/order?symbol=${encodeURIComponent(symbol)}&client_order_id=${encodeURIComponent(clientOrderId)}`).catch((e) => {
      if (e instanceof StrikeError && e.status === 404) return undefined;
      throw e;
    });
    if (!o) return undefined;
    const pick = (...k: string[]) => k.map((x) => o[x]).find((x) => x !== undefined && x !== null && x !== "");
    return {
      id: String(pick("id", "ID") ?? ""),
      status: String(pick("status", "Status") ?? "").toLowerCase(),
      filled: num(pick("filled", "Filled")),
      size: num(pick("size", "Size")),
      reason: (pick("error_message", "close_reason", "CloseReason") as string | undefined) ?? undefined,
    };
  }
}

export type OrderState = { id: string; status: string; filled: number; size: number; reason?: string };

/** Strike's cancel reasons, in words an agent can act on. */
export function explainCancel(reason?: string): string {
  if (reason === "market_order_exceeded_slippage") return "nobody on Strike's order book is trading near the price right now (too little liquidity): nothing was filled";
  return reason ? `Strike cancelled it: ${reason}` : "Strike cancelled it without filling";
}
