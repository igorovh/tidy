import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, buildPatch, git, type GitContext } from "../scripts/lib/patch";

const PROTECTED = [".github/", ".npmrc", "opencode.json"];
let root: string;
let origin: GitContext;
let base: string;

function checkout(name: string): GitContext {
  const ctx = { gitDir: join(root, `${name}.git`), workTree: join(root, name) };
  mkdirSync(ctx.workTree, { recursive: true });
  git(ctx, ["init", "--quiet"]);
  git(ctx, ["fetch", "--quiet", origin.gitDir, base]);
  git(ctx, ["checkout", "--quiet", "--force", base]);
  return ctx;
}

// Mirrors agent.ts: the agent edits a copy without .git; the patch is built with the pristine git dir.
function agentRun(edit: (work: string) => void): Buffer {
  const source = checkout("source");
  const work = join(root, "work");
  cpSync(source.workTree, work, { recursive: true, verbatimSymlinks: true });
  edit(work);
  const ctx = { gitDir: join(root, "patch.git"), workTree: work, indexFile: join(root, "patch.index") };
  cpSync(source.gitDir, ctx.gitDir, { recursive: true });
  return buildPatch(ctx, base, PROTECTED).patch;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tidy-patch-"));
  origin = { gitDir: join(root, "origin", ".git"), workTree: join(root, "origin") };
  mkdirSync(join(origin.workTree, ".github"), { recursive: true });
  git(origin, ["init", "--quiet"]);
  writeFileSync(join(origin.workTree, "src.txt"), "old\n");
  writeFileSync(join(origin.workTree, ".github", "ci.yml"), "on: push\n");
  git(origin, ["add", "."]);
  git(origin, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"]);
  base = git(origin, ["rev-parse", "HEAD"]).toString().trim();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("patch transfer", () => {
  test("source edits and new files reach the publishing checkout unchanged", () => {
    const patch = agentRun((work) => {
      writeFileSync(join(work, "src.txt"), "fixed\n");
      writeFileSync(join(work, "test.txt"), "regression\n");
    });
    const publish = checkout("publish");
    expect(applyPatch(publish, base, patch, PROTECTED).sort()).toEqual(["src.txt", "test.txt"]);
    const staged = git(publish, ["diff", "--cached"]).toString();
    expect(staged).toContain("+fixed");
    expect(readFileSync(join(publish.workTree, "src.txt"), "utf8")).toBe("old\n");
  });

  test("protected paths are rejected, including a file moved out of .github", () => {
    expect(() => agentRun((work) => writeFileSync(join(work, ".github", "ci.yml"), "on: [push, pull_request]\n"))).toThrow("protected");
    expect(() => agentRun((work) => renameSync(join(work, ".github", "ci.yml"), join(work, "ci.yml")))).toThrow("protected");
    expect(() => agentRun((work) => writeFileSync(join(work, "pkg", ".npmrc").replace("pkg", "."), "registry=https://evil\n"))).toThrow("protected");
  });

  test.skipIf(process.platform === "win32")("symlinks are rejected", () => {
    expect(() => agentRun((work) => symlinkSync("/etc/passwd", join(work, "link")))).toThrow("symlink");
  });

  test("an empty change is not a patch", () => {
    expect(() => agentRun(() => {})).toThrow("1 to 100");
  });

  test("a filter planted by the agent never runs while the patch is built", () => {
    const marker = join(root, "pwned");
    agentRun((work) => {
      writeFileSync(join(work, ".gitattributes"), "* filter=evil\n");
      mkdirSync(join(work, ".git"));
      writeFileSync(join(work, ".git", "config"), `[filter "evil"]\n\tclean = touch ${marker.replace(/\\/g, "/")}\n`);
      writeFileSync(join(work, "src.txt"), "fixed\n");
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("a patch edited after the agent job is validated again when applied", () => {
    const publish = checkout("publish");
    const forged = Buffer.from(
      "diff --git a/.github/new.yml b/.github/new.yml\nnew file mode 100644\n--- /dev/null\n+++ b/.github/new.yml\n@@ -0,0 +1 @@\n+bad\n",
    );
    expect(() => applyPatch(publish, base, forged, PROTECTED)).toThrow("protected");
  });
});
