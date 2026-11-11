// Runs the repository's checks and review extras on pull request code. This job holds no credentials at all.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./lib/actions";
import type { Meta } from "./gate";

const MAX_OUTPUT = 15_000;
const BUDGET = 40 * 60_000;
const temp = env("RUNNER_TEMP");
const meta = JSON.parse(readFileSync(join(temp, "context", "meta.json"), "utf8")) as Meta;
const out = join(temp, "checks");
const started = Date.now();
const left = () => BUDGET - (Date.now() - started);
const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
const sandbox = ["--security-opt", "no-new-privileges", "--pids-limit", "2048", "--memory", "8g", "-e", "CI=true"];
const sections: string[] = [`Checks for ${meta.repo}#${meta.number} at ${meta.base}, run without secrets.\n`];

function copy(from: string, name: string): string {
  const dir = join(temp, name);
  cpSync(join(temp, "context", from), dir, { recursive: true, verbatimSymlinks: true });
  return dir;
}

function run(args: string[]): { status: string; tail: string } {
  if (left() <= 0) return { status: "skipped: the 40 minute budget ran out", tail: "" };
  const result = spawnSync("docker", ["run", "--rm", "--init", ...sandbox, ...args], { encoding: "utf8", timeout: left(), maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const tail = output.length > MAX_OUTPUT ? `… (output truncated)\n${output.slice(-MAX_OUTPUT)}` : output;
  return { status: result.error ? `stopped: ${result.error.message}` : `exit code ${result.status}`, tail };
}

const block = (text: string) => `\`\`\`\`text\n${text.replace(/````/g, "'''")}\n\`\`\`\``;

const work = copy("source", "checks-work");
for (const command of meta.config.review.checks) {
  // Without capabilities, root cannot write to the runner-owned checkout; the runner's user can.
  const { status, tail } = run([
    "--user", user, "--cap-drop", "ALL",
    "-e", "HOME=/tmp/home", "-e", "NPM_CONFIG_PREFIX=/tmp/npm", "-e", "PATH=/tmp/npm/bin:/usr/local/bin:/usr/bin:/bin",
    "-v", `${work}:/work`, "-w", "/work",
    meta.config.review.image,
    "bash", "-c", `mkdir -p "$HOME"; command -v bun > /dev/null || npm install --global --loglevel=error bun > /dev/null; ${command}`,
  ]);
  console.log(`${command}: ${status}`);
  sections.push(`## \`${command}\` (${status})\n\n${block(tail)}`);
}

// Extras need root for their setup (installing packages), so they run as root in a container that
// still has no secrets and sees only its own checkout and output folder.
const planFile = join(temp, "plan", "plan.json");
const runs: Record<string, string[]> = existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")).runs : {};
for (const extra of meta.config.review.extras.filter((e) => runs[e.name])) {
  const slug = extra.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (const side of ["after", "before"] as const) {
    const dir = copy(side === "after" ? "source" : "base", `extra-${slug}-${side}`);
    const target = join(out, "extras", slug, side);
    mkdirSync(target, { recursive: true });
    const command = extra.command.map((arg) => arg.replaceAll("{out}", "/out"));
    const { status, tail } = run([
      "-v", `${dir}:/work`, "-v", `${target}:/out`, "-w", "/work",
      extra.image,
      // The setup line comes from the default branch; the arguments are passed as a list, never parsed by a shell.
      "bash", "-c", `set -e\n${extra.setup}\nexec "$@"`, "bash", ...command, ...runs[extra.name]!,
    ]);
    spawnSync("sudo", ["chown", "-R", user, target]);
    const files = readdirSync(target).map((f) => `${f} (${Math.round(statSync(join(target, f)).size / 1024)} KB)`);
    const where = side === "after" ? "this pull request" : `the base branch (${meta.defaultBranch})`;
    console.log(`${extra.name} on ${side}: ${status}`);
    sections.push(
      `## Extra "${extra.name}" on ${where} (${status})\n\nArguments: ${block(JSON.stringify(runs[extra.name]))}\n\nFiles: ${files.join(", ") || "none"}\n\n${block(tail)}`,
    );
  }
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "checks.md"), sections.join("\n\n"));
