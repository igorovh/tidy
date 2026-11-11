import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_FILES = 100;
export const MAX_PATCH_BYTES = 5_000_000;

export interface GitContext {
  gitDir: string;
  workTree: string;
  indexFile?: string;
}

// An empty config file and hooks directory; /dev/null does not work for these on Windows.
const empty = (() => {
  const dir = join(process.env.RUNNER_TEMP ?? tmpdir(), "tidy-git-empty");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "config"), "");
  return dir;
})();

// Git runs with no system or global config, no hooks and no helpers, so repository content cannot run code.
export function git(ctx: GitContext, args: string[], input?: Buffer | string): Buffer {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.RUNNER_TEMP ?? process.env.TEMP ?? "/tmp",
    GIT_DIR: ctx.gitDir,
    GIT_WORK_TREE: ctx.workTree,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(empty, "config"),
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
  };
  if (ctx.indexFile) env.GIT_INDEX_FILE = ctx.indexFile;
  for (const name of ["SYSTEMROOT", "SystemRoot", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name]!;
  const result = spawnSync(
    "git",
    ["-c", `core.hooksPath=${join(empty, "hooks")}`, "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.symlinks=true", ...args],
    { env, input, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

export function isProtected(path: string, protectedPaths: string[]): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop()!;
  return protectedPaths.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule.endsWith("/")) return lower.startsWith(rule) || lower === rule.slice(0, -1);
    return rule.includes("/") ? lower === rule : name === rule;
  });
}

/** Rejects anything a reviewer could miss: protected files, symlinks, submodules, odd paths, huge patches. */
export function validateChanges(ctx: GitContext, base: string, protectedPaths: string[], staged: boolean): string[] {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("Invalid base commit");
  const raw = git(ctx, ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-renames", "--raw", "--no-abbrev", "-z", base, "--"])
    .toString("utf8")
    .split("\0");
  const changes: { mode: string; path: string }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const fields = raw[i]!.slice(1).split(" ");
    changes.push({ mode: fields[1]!, path: raw[i + 1]! });
  }
  if (changes.length < 1 || changes.length > MAX_FILES) throw new Error(`A patch must change 1 to ${MAX_FILES} files`);
  for (const { mode, path } of changes) {
    const parts = path.replace(/\\/g, "/").split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
      throw new Error(`Unsafe path in patch: ${path}`);
    }
    if (isProtected(path, protectedPaths)) throw new Error(`The patch changes protected path ${path}`);
    if (mode === "120000" || mode === "160000") throw new Error(`The patch adds a symlink or submodule: ${path}`);
  }
  return changes.map((change) => change.path);
}

/** Diffs the agent's tree against the pristine commit using a git directory the agent never saw. */
export function buildPatch(ctx: GitContext, base: string, protectedPaths: string[]): { patch: Buffer; files: string[] } {
  git(ctx, ["read-tree", base]);
  git(ctx, ["add", "--all", "--", "."]);
  const files = validateChanges(ctx, base, protectedPaths, true);
  const patch = git(ctx, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", base, "--"]);
  if (patch.length > MAX_PATCH_BYTES) throw new Error("The patch exceeds 5 MB");
  return { patch, files };
}

/** Stages the patch without writing files, then validates exactly what would be committed. */
export function applyPatch(ctx: GitContext, base: string, patch: Buffer, protectedPaths: string[]): string[] {
  if (patch.length > MAX_PATCH_BYTES) throw new Error("The patch exceeds 5 MB");
  git(ctx, ["apply", "--cached", "--check", "-"], patch);
  git(ctx, ["apply", "--cached", "-"], patch);
  return validateChanges(ctx, base, protectedPaths, true);
}
