// Where orders go: Strike itself (live, with the owner's API key), or a paper account that fills at
// Strike's own mark prices (no key needed: for trying the guard before registering an API wallet).
import { StrikeClient, type Account, type Position } from "./strike.ts";

export interface Broker {
  readonly mode: "strike" | "paper";
  account(): Promise<Account>;
  positions(): Promise<Position[]>;
  markPrice(symbol: string): Promise<number>;
  market(symbol: string): Promise<{ stepSize: number; minQty: number; minNotional: number } | undefined>;
  /** Market order; `size` in base units. */
  order(symbol: string, side: "buy" | "sell", size: number, leverage: number, reduceOnly: boolean): Promise<{ id: string }>;
  cancelAll(): Promise<void>;
}

export class StrikeBroker implements Broker {
  readonly mode = "strike" as const;
  constructor(readonly client: StrikeClient) {}
  account() {
    return this.client.account();
  }
  positions() {
    return this.client.positions();
  }
  markPrice(s: string) {
    return this.client.markPrice(s);
  }
  market(s: string) {
    return this.client.market(s);
  }
  async order(symbol: string, side: "buy" | "sell", size: number, leverage: number, reduceOnly: boolean) {
    if (!reduceOnly) await this.client.setLeverage(symbol, Math.floor(leverage));
    const r = await this.client.placeMarket({ symbol, side, size: String(size), reduceOnly });
    return { id: String(r.order_id ?? r.ID ?? r.id ?? "") };
  }
  async cancelAll() {
    await this.client.cancelAll();
  }
}

/** A paper account: real Strike mark prices, simulated fills, no fees or funding. */
export class PaperBroker implements Broker {
  readonly mode = "paper" as const;
  private cash: number;
  private book = new Map<string, { size: number; entry: number; leverage: number }>();
  private n = 0;
  constructor(private readonly prices: Pick<StrikeClient, "markPrice" | "market">, startingUsd = 1_000) {
    this.cash = startingUsd;
  }
  markPrice(s: string) {
    return this.prices.markPrice(s);
  }
  market(s: string) {
    return this.prices.market(s);
  }
  async positions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const [symbol, p] of this.book) {
      const mark = await this.prices.markPrice(symbol);
      out.push({ symbol, size: p.size, entryPrice: p.entry, leverage: p.leverage, upnl: (mark - p.entry) * p.size, liquidationPrice: 0 });
    }
    return out;
  }
  async account(): Promise<Account> {
    const upnl = (await this.positions()).reduce((s, p) => s + p.upnl, 0);
    return { walletBalance: this.cash, marginBalance: this.cash + upnl, availableBalance: this.cash + upnl, unrealizedPnl: upnl };
  }
  async order(symbol: string, side: "buy" | "sell", size: number, leverage: number, _reduceOnly = false) {
    const mark = await this.prices.markPrice(symbol);
    const signed = side === "buy" ? size : -size;
    const cur = this.book.get(symbol) ?? { size: 0, entry: mark, leverage };
    const next = cur.size + signed;
    if (cur.size !== 0 && Math.sign(signed) !== Math.sign(cur.size)) {
      // Closing part (or all) of the position realises its PnL.
      const closed = Math.min(Math.abs(signed), Math.abs(cur.size)) * Math.sign(cur.size);
      this.cash += (mark - cur.entry) * closed;
    }
    if (Math.abs(next) < 1e-12) this.book.delete(symbol);
    else if (cur.size === 0 || Math.sign(next) !== Math.sign(cur.size)) this.book.set(symbol, { size: next, entry: mark, leverage });
    else if (Math.abs(next) > Math.abs(cur.size)) this.book.set(symbol, { size: next, entry: (cur.entry * cur.size + mark * signed) / next, leverage });
    else this.book.set(symbol, { ...cur, size: next });
    return { id: `paper-${++this.n}` };
  }
  async cancelAll() {}
}
