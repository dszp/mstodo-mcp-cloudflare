import { describe, it, expect } from "vitest";
import { taskSubscriptionsEnabled, webhookUrl } from "../src/subscriptions/gate";

const base = { SERVICE_BASE_URL: "https://h.example.com" } as unknown as Env;

describe("taskSubscriptionsEnabled", () => {
  it("defaults ON when unset", () => {
    expect(taskSubscriptionsEnabled(base)).toBe(true);
  });
  it("is OFF only for the literal string 'false' (case-insensitive)", () => {
    expect(taskSubscriptionsEnabled({ ...base, ENABLE_TASK_SUBSCRIPTIONS: "false" } as Env)).toBe(false);
    expect(taskSubscriptionsEnabled({ ...base, ENABLE_TASK_SUBSCRIPTIONS: "FALSE" } as Env)).toBe(false);
    expect(taskSubscriptionsEnabled({ ...base, ENABLE_TASK_SUBSCRIPTIONS: "true" } as Env)).toBe(true);
    expect(taskSubscriptionsEnabled({ ...base, ENABLE_TASK_SUBSCRIPTIONS: "0" } as Env)).toBe(true);
  });
});

describe("webhookUrl", () => {
  it("derives ${SERVICE_BASE_URL}/webhook and tolerates a trailing slash", () => {
    expect(webhookUrl(base)).toBe("https://h.example.com/webhook");
    expect(webhookUrl({ ...base, SERVICE_BASE_URL: "https://h.example.com/" } as Env)).toBe(
      "https://h.example.com/webhook",
    );
  });
  it("returns null when SERVICE_BASE_URL is unset or not https", () => {
    expect(webhookUrl({} as Env)).toBeNull();
    expect(webhookUrl({ SERVICE_BASE_URL: "http://insecure" } as Env)).toBeNull();
  });
});
