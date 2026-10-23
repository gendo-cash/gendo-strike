// The guard: the only holder of the Strike API key. Every order the agent asks for is checked against
// the owner's mandate first; every decision (allowed or refused, with the agent's own reason) is journaled;
// a watcher closes everything and stops trading once the day's loss reaches the limit.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Broker } from "./broker.ts";
import { check, lossBreached, mandateProblems, type Book, type Mandate } from "./mandate.ts";

export type Entry = {
  at: number;
  kind: "order" | "close" | "refused" | "unfilled" | "stop" | "resume" | "mandate" | "error";
  symbol?: string;
  side?: "buy" | "sell";
  notionalUsd?: number;
  leverage?: number;
  size?: number;
  code?: string;
  detail?: string;
  /** The agent's words, recorded as it gave them. */
  reason?: string;
};

export type Snapshot = {
  mode: Broker["mode"];
  mandate: Mandate;
  locked?: string;
  equity: number;
  startEquity: number;
  dayPnl: number;
  positions: { symbol: string; size: number; side: "long" | "short"; entryPrice: number; mark: number; notionalUsd: number; leverage: number; upnl: number; liquidationPrice: number }[];
  exposureUsd: number;
  journal: Entry[];
};

const day = (ms: number) => Math.floor(ms / 86_400_000);

export class Guard {
  private recentOrdersMs: number[] = [];
  private locked?: string;
  private startEquity?: { day: number; equity: number };
  private journal: Entry[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly broker: Broker,
    private current: Mandate,
    private readonly journalPath?: string,
    private readonly now = () => Date.now(),
    /** Where an owner's change is kept (the mandate file). */
    private readonly save?: (m: Mandate) => void,
  ) {
    if (journalPath && existsSync(journalPath))
      this.journal = readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry).slice(-500);
    // A stop survives a restart: only the owner lifts it.
    const last = [...this.journal].reverse().find((e) => e.kind === "stop" || e.kind === "resume");
    if (last?.kind === "stop") this.locked = last.detail;
  }

  private log(e: Omit<Entry, "at">): Entry {
    const full = { at: this.now(), ...e };
    this.journal.push(full);
    if (this.journal.length > 500) this.journal.shift();
    if (this.journalPath) {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      appendFileSync(this.journalPath, JSON.stringify(full) + "\n");
    }
    return full;
  }

  get mandate(): Mandate {
    return this.current;
  }

  /** The owner changes the rules. Applies to the next order; open positions stay open. */
  setMandate(next: Mandate): { ok: true } | { ok: false; problems: string[] } {
    const problems = mandateProblems(next);
    if (problems.length) return { ok: false, problems };
    const before = this.current;
    const usd = (n: number) => `${n} USD`;
    const diff = [
      before.markets.join() !== next.markets.join() ? `markets ${before.markets.join(", ")} → ${next.markets.join(", ")}` : "",
      before.maxLeverage !== next.maxLeverage ? `max leverage ${before.maxLeverage}× → ${next.maxLeverage}×` : "",
      before.maxPositionUsd !== next.maxPositionUsd ? `max per market ${usd(before.maxPositionUsd)} → ${usd(next.maxPositionUsd)}` : "",
      before.maxExposureUsd !== next.maxExposureUsd ? `max exposure ${usd(before.maxExposureUsd)} → ${usd(next.maxExposureUsd)}` : "",
      before.maxDailyLossUsd !== next.maxDailyLossUsd ? `daily loss stop ${usd(before.maxDailyLossUsd)} → ${usd(next.maxDailyLossUsd)}` : "",
      before.maxOrdersPerMinute !== next.maxOrdersPerMinute ? `orders per minute ${before.maxOrdersPerMinute} → ${next.maxOrdersPerMinute}` : "",
    ].filter(Boolean);
    this.current = { ...next, markets: [...next.markets] };
    this.save?.(this.current);
    if (diff.length) this.log({ kind: "mandate", detail: diff.join("; ") });
    return { ok: true };
  }

  /** One order at a time: two concurrent orders can't both pass a check meant for one. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async book(): Promise<Book & { marks: Map<string, number> }> {
    const positions = await this.broker.positions();
    const marks = new Map<string, number>();
    for (const p of positions) marks.set(p.symbol, await this.broker.markPrice(p.symbol));
    return { positions: positions.map((p) => ({ symbol: p.symbol, size: p.size, mark: marks.get(p.symbol)! })), recentOrdersMs: this.recentOrdersMs, ...(this.locked ? { locked: this.locked } : {}), marks };
  }

  /** The agent asks to trade. Returns what happened, in words the agent can act on. */
  trade(i: { symbol: string; side: "buy" | "sell"; notionalUsd: number; leverage: number; reason: string }) {
    return this.serial(async () => {
      await this.watch();
      const market = await this.broker.market(i.symbol);
      if (!market) return this.refuse(i, "MARKET", `${i.symbol} isn't a market on Strike`);
      const mark = await this.broker.markPrice(i.symbol);
      const book = await this.book();
      const v = check(this.mandate, book, i, { mark, ...market }, this.now());
      if (!v.ok) return this.refuse(i, v.code, v.reason);
      const cur = book.positions.find((p) => p.symbol === i.symbol)?.size ?? 0;
      const reduces = cur !== 0 && Math.sign(i.side === "buy" ? 1 : -1) !== Math.sign(cur);
      try {
        const r = await this.broker.order(i.symbol, i.side, v.size, i.leverage, reduces && v.size <= Math.abs(cur));
        if (!reduces) this.recentOrdersMs = [...this.recentOrdersMs.filter((t) => this.now() - t < 60_000), this.now()];
        if (r.filled === 0) {
          this.log({ kind: "unfilled", symbol: i.symbol, side: i.side, notionalUsd: i.notionalUsd, leverage: i.leverage, size: v.size, detail: r.reason, reason: i.reason });
          return { status: "not_filled", symbol: i.symbol, message: r.reason, next: "Nothing changed. Try a smaller size, another market, or later." };
        }
        this.log({ kind: "order", symbol: i.symbol, side: i.side, notionalUsd: i.notionalUsd, leverage: i.leverage, size: r.filled, detail: r.id, reason: i.reason });
        return { status: r.filled < v.size ? "partially_filled" : "filled", order_id: r.id, symbol: i.symbol, side: i.side, size: r.filled, mark_price: mark, ...(r.reason ? { note: r.reason } : {}) };
      } catch (e) {
        this.log({ kind: "error", symbol: i.symbol, detail: (e as Error).message, reason: i.reason });
        return { status: "error", message: `Strike refused the order: ${(e as Error).message}` };
      }
    });
  }

  private refuse(i: { symbol: string; side: "buy" | "sell"; notionalUsd: number; leverage: number; reason: string }, code: string, detail: string) {
    this.log({ kind: "refused", symbol: i.symbol, side: i.side, notionalUsd: i.notionalUsd, leverage: i.leverage, code, detail, reason: i.reason });
    return { status: "refused", code, message: detail, next: code === "LOCKED" ? "Only close_position works until the owner resumes trading." : "Stay inside the mandate (see get_mandate)." };
  }

  /** Close one position fully. Always allowed: reducing risk is never blocked. */
  close(symbol: string, reason: string) {
    return this.serial(() => this.closeNow(symbol, reason));
  }

  // Not queued: the loss stop runs inside an order's turn and must close at once.
  private async closeNow(symbol: string, reason: string) {
    const p = (await this.broker.positions()).find((x) => x.symbol === symbol);
    if (!p) return { status: "no_position", symbol };
    try {
      const r = await this.broker.order(symbol, p.size > 0 ? "sell" : "buy", Math.abs(p.size), p.leverage, true);
      if (r.filled === 0) {
        this.log({ kind: "unfilled", symbol, size: Math.abs(p.size), detail: r.reason, reason });
        return { status: "not_filled", symbol, message: r.reason, next: "The position is still open. Try again in a moment." };
      }
      this.log({ kind: "close", symbol, size: r.filled, detail: r.id, reason });
      return { status: r.filled < Math.abs(p.size) ? "partially_closed" : "closed", symbol, size: r.filled, order_id: r.id };
    } catch (e) {
      this.log({ kind: "error", symbol, detail: (e as Error).message, reason });
      return { status: "error", message: `Strike refused the close: ${(e as Error).message}` };
    }
  }

  /** Close everything and stop new trades until the owner resumes. */
  async stop(why: string) {
    if (!this.locked) {
      this.locked = why;
      this.log({ kind: "stop", detail: why });
    }
    await this.broker.cancelAll().catch(() => undefined);
    for (const p of await this.broker.positions()) await this.closeNow(p.symbol, `guard: ${why}`);
  }

  /** The owner's stop button: waits for any order in flight, then closes everything. */
  kill(why = "stopped by the owner") {
    return this.serial(() => this.stop(why));
  }

  resume() {
    if (!this.locked) return;
    this.locked = undefined;
    this.log({ kind: "resume", detail: "resumed by the owner" });
  }

  /** The daily loss stop. Runs before every trade and on a timer. */
  async watch(): Promise<void> {
    const eq = (await this.broker.account()).marginBalance;
    const d = day(this.now());
    if (!this.startEquity || this.startEquity.day !== d) this.startEquity = { day: d, equity: eq };
    if (!this.locked && lossBreached(this.mandate, this.startEquity.equity, eq))
      await this.stop(`daily loss limit reached (${(this.startEquity.equity - eq).toFixed(2)} USD lost today; the limit is ${this.mandate.maxDailyLossUsd} USD)`);
  }

  async snapshot(): Promise<Snapshot> {
    await this.watch().catch(() => undefined);
    const acct = await this.broker.account();
    const ps = await this.broker.positions();
    const positions = await Promise.all(
      ps.map(async (p) => {
        const mark = await this.broker.markPrice(p.symbol);
        return { symbol: p.symbol, size: Math.abs(p.size), side: (p.size > 0 ? "long" : "short") as "long" | "short", entryPrice: p.entryPrice, mark, notionalUsd: Math.abs(p.size) * mark, leverage: p.leverage, upnl: p.upnl, liquidationPrice: p.liquidationPrice };
      }),
    );
    const start = this.startEquity?.equity ?? acct.marginBalance;
    return {
      mode: this.broker.mode, mandate: this.mandate, ...(this.locked ? { locked: this.locked } : {}),
      equity: acct.marginBalance, startEquity: start, dayPnl: acct.marginBalance - start,
      positions, exposureUsd: positions.reduce((s, p) => s + p.notionalUsd, 0), journal: this.journal.slice(-100).reverse(),
    };
  }
}
