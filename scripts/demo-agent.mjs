// A scripted stand-in for an AI agent, for demos: it connects to gendo-strike over MCP exactly like an AI app,
// makes a few trades the mandate allows and a few it doesn't, then keeps the server up so the dashboard stays live.
//   node scripts/demo-agent.mjs [home] [port]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const here = new URL("..", import.meta.url).pathname;
const [home = `${here}.demo-home`, port = "8711"] = process.argv.slice(2);
const bin = `${here}bin/gendo-strike`;
const c = new Client({ name: "seed", version: "0" });
await c.connect(new StdioClientTransport({ command: bin, args: ["--home", home, "--port", port], env: { ...process.env, STRIKE_API_KEY: "" } }));
const call = async (name, args) => console.error(name, (await c.callTool({ name, arguments: args })).content[0].text.slice(0, 120).replace(/\n/g, " "));
await call("open_position", { symbol: "BTC-USD", side: "long", notional_usd: 300, leverage: 3, reason: "BTC reclaimed its 4h range high with rising open interest" });
await call("open_position", { symbol: "ETH-USD", side: "short", notional_usd: 200, leverage: 2, reason: "Hedge: ETH/BTC is breaking down" });
await call("open_position", { symbol: "BTC-USD", side: "long", notional_usd: 400, leverage: 3, reason: "Adding to the winner" });
await call("open_position", { symbol: "SOL-USD", side: "long", notional_usd: 150, leverage: 10, reason: "SOL looks oversold" });
await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 600_000)));
await c.close();
