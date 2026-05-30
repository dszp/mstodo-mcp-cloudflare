import { env as rawEnv } from "cloudflare:test";
import { describe, it, expect } from "vitest";
const env = rawEnv as unknown as Env;
import { handleWebhook } from "../src/subscriptions/webhook-handler";

// Minimal ExecutionContext stub whose waitUntil work is awaitable via settle().
function ctxStub() {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(tasks),
  };
}

describe("handleWebhook", () => {
  it("returns null for any non-/webhook path", async () => {
    const { ctx } = ctxStub();
    expect(await handleWebhook(new Request("https://x/other"), env, ctx)).toBeNull();
  });

  it("echoes a validationToken as text/plain 200, DO-free", async () => {
    const { ctx } = ctxStub();
    const token = "abc 123+/=token";
    const req = new Request(`https://x/webhook?validationToken=${encodeURIComponent(token)}`, {
      method: "POST",
    });
    const res = await handleWebhook(req, env, ctx);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/plain");
    expect(await res!.text()).toBe(token); // URL-decoded, plain text
  });

  it("acks a notification with 202 and defers processing", async () => {
    const { ctx, settle } = ctxStub();
    const body = JSON.stringify({ value: [{ subscriptionId: "SUB1", clientState: "good" }] });
    const req = new Request("https://x/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const res = await handleWebhook(req, env, ctx);
    expect(res!.status).toBe(202);
    await settle(); // deferred DO call settles without throwing through
  });

  it("returns 202 for an unparseable body (never makes Graph retry on our parse error)", async () => {
    const { ctx } = ctxStub();
    const req = new Request("https://x/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleWebhook(req, env, ctx);
    expect(res!.status).toBe(202);
  });
});
