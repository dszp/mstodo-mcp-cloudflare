import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url).pathname;

describe("deployment files stay out of git", () => {
  const paths = [
    "deployments/x/deployment.jsonc",
    "deployments/x/.dev.vars",
    "deployments/x/last-deployed.json",
    ".wrangler/deployments/x/rendered.json",
  ];
  for (const path of paths) {
    it(`ignores ${path}`, () => {
      const r = spawnSync("git", ["check-ignore", "-q", path], { cwd: root });
      expect(r.status, `git check-ignore ${path}`).toBe(0);
    });
  }
});
