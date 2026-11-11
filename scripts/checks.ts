// Runs the repository's own checks on pull request code. This job holds no credentials at all.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./lib/actions";
import type { Meta } from "./gate";

const MAX_OUTPUT = 15_000;
const temp = env("RUNNER_TEMP");
const meta = JSON.parse(readFileSync(join(temp, "context", "meta.json"), "utf8")) as Meta;
const work = join(temp, "checks-work");
cpSync(join(temp, "context", "source"), work, { recursive: true, verbatimSymlinks: true });

const sections: string[] = [`Checks for ${meta.repo}#${meta.number} at ${meta.base}, run without secrets.\n`];
const started = Date.now();
for (const command of meta.config.review.checks) {
  const left = 25 * 60_000 - (Date.now() - started);
  if (left <= 0) {
    sections.push(`## \`${command}\`\n\nSkipped: the 25 minute budget for checks ran out.`);
    continue;
  }
  const result = spawnSync(
    "docker",
    [
      "run", "--rm", "--init",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "2048", "--memory", "8g",
      "-e", "CI=true", "-e", "HOME=/tmp/home", "-e", "NPM_CONFIG_PREFIX=/tmp/npm", "-e", "PATH=/tmp/npm/bin:/usr/local/bin:/usr/bin:/bin",
      "-v", `${work}:/work`, "-w", "/work",
      meta.config.review.image,
      "bash", "-c", `mkdir -p "$HOME"; command -v bun > /dev/null || npm install --global --loglevel=error bun > /dev/null; ${command}`,
    ],
    { encoding: "utf8", timeout: left, maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const tail = output.length > MAX_OUTPUT ? `… (output truncated)\n${output.slice(-MAX_OUTPUT)}` : output;
  const status = result.error ? `stopped: ${result.error.message}` : `exit code ${result.status}`;
  console.log(`${command}: ${status}`);
  sections.push(`## \`${command}\` (${status})\n\n\`\`\`\`text\n${tail.replace(/````/g, "'''")}\n\`\`\`\``);
}
mkdirSync(join(temp, "checks"), { recursive: true });
writeFileSync(join(temp, "checks", "checks.md"), sections.join("\n\n"));
