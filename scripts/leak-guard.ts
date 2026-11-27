// Leak guard: refuses committed content or commit messages that contain a
// private term (a real hostname, a business or client name, a real list name).
//   node scripts/leak-guard.ts                    tree at HEAD
//   node scripts/leak-guard.ts --log A..B         also the messages of commits A..B
//   node scripts/leak-guard.ts --pre-push         as a git pre-push hook (reads stdin)
// The terms never live in the repository, since a committed denylist would
// publish them. They come from the LEAK_PATTERNS environment variable (CI reads
// it from an Actions secret) or else from `leak-patterns` in the git common
// directory (.git/leak-patterns), which every worktree of the clone shares.
// One case-insensitive literal term per line; `#` starts a comment.
// With CI set, findings name only the file, line and pattern number: Actions
// logs on a public repository are public. Erasable TypeScript only: Node runs
// this file directly.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Source {
  label: string;
  text: string;
}

export interface Leak {
  label: string;
  line: number;
  /** 1-based position of the term in the pattern list. */
  pattern: number;
  text: string;
}

export function parsePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

export function findLeaks(sources: Source[], patterns: string[]): Leak[] {
  const leaks: Leak[] = [];
  for (const { label, text } of sources) {
    text.split("\n").forEach((raw, i) => {
      // Backslashes removed so `acme\\.example` in a regex still matches `acme.example`.
      const line = raw.replaceAll("\\", "").toLowerCase();
      const hit = patterns.findIndex((p) => line.includes(p));
      if (hit >= 0) leaks.push({ label, line: i + 1, pattern: hit + 1, text: raw.trim() });
    });
  }
  return leaks;
}

export function formatLeak(leak: Leak, redact: boolean): string {
  const where = `${leak.label}:${leak.line}: pattern #${leak.pattern}`;
  return redact ? where : `${where}: ${leak.text}`;
}

const ZERO = /^0+$/;

/** The pushed tips and their new commits, from a pre-push hook's stdin. */
export function pushRanges(stdin: string): { tip: string; range: string[] }[] {
  const out: { tip: string; range: string[] }[] = [];
  for (const line of stdin.split("\n")) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // empty line or a deletion
    const range = !remoteSha || ZERO.test(remoteSha) ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`];
    out.push({ tip: localSha, range });
  }
  return out;
}

function git(args: string[], input?: string): Buffer {
  const r = spawnSync("git", args, { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** Every text file in the tree at `rev`, plus the list of paths itself. */
function treeSources(rev: string): Source[] {
  const entries = git(["ls-tree", "-r", "-z", rev])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((e) => {
      const [meta, path] = e.split("\t");
      const [, type, sha] = meta.split(" ");
      return { type, sha, path };
    })
    .filter((e) => e.type === "blob");
  const batch = git(["cat-file", "--batch"], entries.map((e) => e.sha).join("\n") + "\n");
  const sources: Source[] = [{ label: `paths@${rev.slice(0, 12)}`, text: entries.map((e) => e.path).join("\n") }];
  let at = 0;
  for (const { path } of entries) {
    const nl = batch.indexOf(0x0a, at);
    const size = Number(batch.subarray(at, nl).toString().split(" ")[2]);
    const body = batch.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    if (!body.includes(0)) sources.push({ label: path, text: body.toString("utf8") });
  }
  return sources;
}

function messageSources(range: string[]): Source[] {
  return git(["log", "--format=%h%x00%B%x1e", ...range])
    .toString()
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, body] = r.split("\0");
      return { label: `commit ${sha}`, text: body };
    });
}

function loadPatterns(env: NodeJS.ProcessEnv): string[] | null {
  if (env.LEAK_PATTERNS?.trim()) return parsePatterns(env.LEAK_PATTERNS);
  const file = join(resolve(git(["rev-parse", "--git-common-dir"]).toString().trim()), "leak-patterns");
  return existsSync(file) ? parsePatterns(readFileSync(file, "utf8")) : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const patterns = loadPatterns(process.env);
  if (!patterns?.length) {
    console.error("leak-guard: no patterns. Set LEAK_PATTERNS or write .git/leak-patterns (one term per line).");
    process.exit(2);
  }
  let sources: Source[];
  if (args[0] === "--pre-push") {
    sources = pushRanges(readFileSync(0, "utf8")).flatMap(({ tip, range }) => [
      ...treeSources(tip),
      ...messageSources(range),
    ]);
  } else {
    const log = args[0] === "--log" ? args[1] : undefined;
    sources = [...treeSources("HEAD"), ...(log ? messageSources([log]) : [])];
  }
  const redact = Boolean(process.env.CI);
  const leaks = findLeaks(sources, patterns);
  for (const leak of leaks) console.error(formatLeak(leak, redact));
  if (leaks.length) {
    console.error(`leak-guard: ${leaks.length} line(s) match a private term.`);
    process.exit(1);
  }
  console.log(`leak-guard: clean (${patterns.length} terms, ${sources.length} sources).`);
}
