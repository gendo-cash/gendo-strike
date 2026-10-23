import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiKeyFromHex, signedHeaders } from "../src/strike.ts";

// RFC 8032 test vector 1: this seed's public key is d75a9801…511a.
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

describe("Strike request signing", () => {
  it("derives the public key Strike expects from a raw seed, and from seed + public key", () => {
    expect(apiKeyFromHex(SEED).publicHex).toBe(PUB);
    expect(apiKeyFromHex(SEED + PUB).publicHex).toBe(PUB);
    expect(() => apiKeyFromHex("abcd")).toThrow(/64 or 128 hex/);
  });
  it("signs METHOD:PATH:TIMESTAMP:NONCE:SHA256(body), verifiable with the public key", () => {
    const k = apiKeyFromHex(SEED);
    const body = JSON.stringify({ symbol: "BTC-USD", side: "buy", type: "market", size: "0.001" });
    const h = signedHeaders(k, "post", "/v2/order", body, 1704067200, "550e8400-e29b-41d4-a716-446655440000");
    expect(h["X-API-Wallet-Public-Key"]).toBe(PUB);
    expect(h["X-API-Wallet-Timestamp"]).toBe("1704067200");
    const msg = `POST:/v2/order:1704067200:550e8400-e29b-41d4-a716-446655440000:${createHash("sha256").update(body).digest("hex")}`;
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PUB, "hex")]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(msg), pub, Buffer.from(h["X-API-Wallet-Signature"], "hex"))).toBe(true);
  });
  it("a GET signs the hash of the empty string", () => {
    const k = apiKeyFromHex(SEED);
    const h = signedHeaders(k, "GET", "/v2/positions", "", 1, "n");
    const msg = `GET:/v2/positions:1:n:${createHash("sha256").update("").digest("hex")}`;
    const pub = createPublicKey(k.key);
    expect(verify(null, Buffer.from(msg), pub, Buffer.from(h["X-API-Wallet-Signature"], "hex"))).toBe(true);
  });
});
