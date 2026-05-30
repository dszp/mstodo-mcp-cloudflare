import { describe, it, expect } from "vitest";
import { checklistCacheEnabled, checklistScanMaxTasksPerCycle } from "../src/checklist/gate";

const base = {} as unknown as Env;

describe("checklistCacheEnabled", () => {
  it("defaults OFF when the var is unset (opt-in feature)", () => {
    expect(checklistCacheEnabled(base)).toBe(false);
  });
  it("is ON only for the literal 'true' (case-insensitive)", () => {
    expect(checklistCacheEnabled({ ...base, ENABLE_CHECKLIST_CACHE: "true" } as unknown as Env)).toBe(true);
    expect(checklistCacheEnabled({ ...base, ENABLE_CHECKLIST_CACHE: "TRUE" } as unknown as Env)).toBe(true);
  });
  it("stays OFF for any non-'true' value", () => {
    expect(checklistCacheEnabled({ ...base, ENABLE_CHECKLIST_CACHE: "false" } as unknown as Env)).toBe(false);
    expect(checklistCacheEnabled({ ...base, ENABLE_CHECKLIST_CACHE: "1" } as unknown as Env)).toBe(false);
    expect(checklistCacheEnabled({ ...base, ENABLE_CHECKLIST_CACHE: "yes" } as unknown as Env)).toBe(false);
  });
});

describe("checklistScanMaxTasksPerCycle", () => {
  it("defaults to a small free-tier-safe cap", () => {
    expect(checklistScanMaxTasksPerCycle(base)).toBe(8);
  });
  it("honors a positive integer override", () => {
    expect(checklistScanMaxTasksPerCycle({ ...base, CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE: "100" } as unknown as Env)).toBe(100);
  });
  it("falls back to the default for non-positive / garbage values", () => {
    expect(checklistScanMaxTasksPerCycle({ ...base, CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE: "0" } as unknown as Env)).toBe(8);
    expect(checklistScanMaxTasksPerCycle({ ...base, CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE: "x" } as unknown as Env)).toBe(8);
  });
});
