// Cloudflare Access JWT verification on workerd's WebCrypto. Twin:
// test-node/access-verifier.test.ts.
import { describe } from "vitest";
import { defineAccessVerifierTests } from "./_access-verifier-checks";

describe("Cloudflare Access verification (workers)", defineAccessVerifierTests);
