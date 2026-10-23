// gendo-strike: an MCP server an AI app starts, plus the owner's dashboard, in one process.
//
//   gendo-strike [--mandate mandate.json] [--home ~/.gendo-strike] [--port 8711] [--network testnet|mainnet]
//   The Strike API wallet's private key (hex): <home>/api-key (mode 600), or STRIKE_API_KEY.
//   Without one, a paper account at Strike's prices.
//
// The AI app (Claude Desktop, Claude Code, Cursor...) only sees the tools. The key stays in this process.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperBroker, StrikeBroker } from "./broker.ts";
import { startDashboard } from "./dashboard.ts";
import { Guard } from "./guard.ts";
import { EXAMPLE_MANDATE, mandateProblems, type Mandate } from "./mandate.ts";
import { StrikeClient, apiKeyFromHex, type StrikeNetwork } from "./strike.ts";
import { INSTRUCTIONS, registerTools } from "./tools.ts";

// stdout carries the MCP protocol; anything else printed there would corrupt it.
console.log = (...a: unknown[]) => console.error(...a);

const { values: v } = parseArgs({
  options: { mandate: { type: "string" }, home: { type: "string" }, port: { type: "string" }, network: { type: "string" }, "no-mcp": { type: "boolean" } },
});
const home = resolve(v.home ?? process.env.GENDO_STRIKE_HOME ?? join(homedir(), ".gendo-strike"));
mkdirSync(home, { recursive: true, mode: 0o700 });

const mandatePath = resolve(v.mandate ?? join(home, "mandate.json"));
if (!existsSync(mandatePath)) writeFileSync(mandatePath, JSON.stringify(EXAMPLE_MANDATE, null, 2) + "\n");
const mandate = JSON.parse(readFileSync(mandatePath, "utf8")) as Mandate;
const problems = mandateProblems(mandate);
if (problems.length) {
  console.error(`mandate ${mandatePath}: ${problems.join("; ")}`);
  process.exit(2);
}

const network = (v.network ?? process.env.STRIKE_NETWORK ?? "testnet") as StrikeNetwork;
if (network !== "testnet" && network !== "mainnet") throw new Error("--network is testnet or mainnet");
// The key file keeps the secret out of the AI app's own config, which the app (and its logs) can read.
const keyFile = join(home, "api-key");
const keyHex = process.env.STRIKE_API_KEY?.trim() || (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "");
// Optional: a Strike sub-account just for the agent (create it in Strike's app and move funds in). Then the most
// the agent can ever lose is what's in it: Strike keeps the rest of the account out of its reach.
const subFile = join(home, "sub-account");
const subAccount = process.env.STRIKE_SUB_ACCOUNT?.trim() || (existsSync(subFile) ? readFileSync(subFile, "utf8").trim() : "") || undefined;
const client = new StrikeClient(network, keyHex ? apiKeyFromHex(keyHex) : undefined, keyHex ? subAccount : undefined);
const broker = keyHex ? new StrikeBroker(client) : new PaperBroker(client, Number(process.env.PAPER_USD ?? 1000));
const guard = new Guard(broker, mandate, join(home, broker.mode === "strike" ? `journal-${network}.jsonl` : "journal-paper.jsonl"), Date.now, (m) =>
  writeFileSync(mandatePath, JSON.stringify(m, null, 2) + "\n"),
);

// The owner's token: resuming after a stop needs it. Kept in the home folder, which the agent can't read through its tools.
const tokenPath = join(home, "owner-token");
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(18).toString("base64url") + "\n", { mode: 0o600 });
const ownerToken = readFileSync(tokenPath, "utf8").trim();
const port = Number(v.port ?? process.env.GENDO_STRIKE_PORT ?? 8711);
startDashboard(guard, port, ownerToken);
setInterval(() => void guard.watch().catch((e) => console.error(`watch: ${(e as Error).message}`)), 15_000);

console.error(`gendo-strike: ${broker.mode === "strike" ? `Strike ${network} ${client.subAccountId ? `sub-account ${client.subAccountId}` : "account"}` : `paper account at Strike ${network} prices`}; mandate ${mandatePath}`);
console.error(`owner dashboard: http://127.0.0.1:${port}/?owner=${ownerToken}`);

if (!v["no-mcp"]) {
  const server = new McpServer({ name: "gendo-strike", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, guard, client);
  await server.connect(new StdioServerTransport());
}
