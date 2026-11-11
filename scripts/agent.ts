// Runs OpenCode for one task inside a container that sees only the workspace, the snapshot and its output file.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, setOutput } from "./lib/actions";
import { parseTriage, route } from "./lib/config";
import { requestCredentials } from "./lib/credentials";
import { type AgentTask, PROJECT_CONFIG, sandboxConfig } from "./lib/opencode";
import { buildPatch } from "./lib/patch";
import { validateReview } from "./lib/review";
import { sanitize, singleLine } from "./lib/sanitize";
import type { Meta } from "./gate";

const TITLE = /^(feat|fix|docs|refactor|perf|test|build|ci|chore|style|revert)(\([^\r\n)]{1,40}\))?!?: \S.{0,90}$/;

const temp = env("RUNNER_TEMP");
const task = env("TASK") as AgentTask;
const model = env("MODEL");
const context = join(temp, "context");
const meta = JSON.parse(readFileSync(join(context, "meta.json"), "utf8")) as Meta;
const shell = task === "fix" && meta.trusted && env("SHELL_ALLOWED") === "true";
const sandbox = join(temp, "sandbox");
const resultDir = join(temp, "result");

function prompt(): string {
  const shellNote = shell
    ? "You have a shell. Install dependencies and run the project's checks before you finish."
    : "You have no shell. Edit files only and say in the pull request body that no checks were run; CI will run them.";
  const read = (name: string) => readFileSync(join(env("TIDY_ROOT"), "prompts", `${name}.md`), "utf8");
  // Triage and plan only answer with JSON, so they need no writing style.
  const text = task === "triage" || task === "plan" ? read(task) : `${read(task)}\n${read("style")}`;
  const extras = meta.config.review.extras
    .filter((extra) => meta.extras.includes(extra.name))
    .map((extra) => `### ${extra.name}\n\nCommand: \`${extra.command.join(" ")}\` followed by your arguments.\n\n${extra.instructions}`)
    .join("\n\n");
  return text
    .replaceAll("{{repo}}", meta.repo)
    .replaceAll("{{number}}", String(meta.number))
    .replaceAll("{{shell}}", shellNote)
    .replaceAll("{{extras}}", extras);
}

function prepareSandbox(): { work: string; stash: string } {
  rmSync(sandbox, { recursive: true, force: true });
  const work = join(sandbox, "work");
  const stash = join(sandbox, "stash");
  mkdirSync(join(sandbox, "out"), { recursive: true });
  mkdirSync(join(sandbox, "context"), { recursive: true });
  mkdirSync(join(sandbox, "etc"), { recursive: true });
  mkdirSync(stash, { recursive: true });
  if (task === "triage") mkdirSync(work);
  else cpSync(join(context, "source"), work, { recursive: true, verbatimSymlinks: true });
  for (const name of PROJECT_CONFIG) if (existsSync(join(work, name))) renameSync(join(work, name), join(stash, name));
  for (const name of ["thread.md", "diff.patch"]) if (existsSync(join(context, name))) cpSync(join(context, name), join(sandbox, "context", name));
  const checks = join(temp, "checks", "checks.md");
  if (task === "review") writeFileSync(join(sandbox, "context", "checks.md"), existsSync(checks) ? readFileSync(checks) : "No checks are configured.\n");
  writeFileSync(join(sandbox, "context", "prompt.md"), prompt());
  writeFileSync(join(sandbox, "etc", "opencode.json"), JSON.stringify(sandboxConfig(task, shell), null, 2));
  return { work, stash };
}

function runContainer(work: string, keys: Record<string, string>): void {
  // The key file lives outside every mount and is deleted as soon as the container exits.
  const keyFile = join(temp, `keys-${process.pid}.env`);
  writeFileSync(keyFile, Object.entries(keys).map(([name, value]) => `${name}=${value}`).join("\n") + "\n");
  chmodSync(keyFile, 0o600);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const install = shell ? '"@opencode/cli@$OPENCODE_VERSION" bun' : '"@opencode/cli@$OPENCODE_VERSION"';
  const script = [
    "set -e",
    'mkdir -p "$HOME"',
    `npm install --global --no-fund --no-audit --loglevel=error ${install} > /dev/null`,
    'exec opencode run --standalone --auto -m "$MODEL" "$(cat /tidy/context/prompt.md)"',
  ].join("\n");
  const readOnly = task === "fix" ? "" : ":ro";
  try {
    const result = spawnSync(
      "docker",
      [
        "run", "--rm", "--init",
        "--user", `${uid}:${gid}`,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "2048", "--memory", "8g",
        "--env-file", keyFile,
        "-e", "HOME=/tmp/home", "-e", "NPM_CONFIG_PREFIX=/tmp/npm", "-e", "PATH=/tmp/npm/bin:/usr/local/bin:/usr/bin:/bin",
        "-e", `MODEL=${model}`, "-e", `OPENCODE_VERSION=${meta.config.agent.opencode}`,
        "-v", `${work}:/work${readOnly}`,
        "-v", `${join(sandbox, "context")}:/tidy/context:ro`,
        "-v", `${join(sandbox, "out")}:/tidy/out`,
        "-v", `${join(sandbox, "etc")}:/etc/opencode:ro`,
        "-w", "/work",
        meta.config.agent.image,
        "bash", "-c", script,
      ],
      { stdio: "inherit", timeout: meta.config.agent.timeout_minutes * 60_000 },
    );
    if (result.error) console.error(`Agent container stopped: ${result.error.message}`);
    else if (result.status !== 0) console.error(`Agent container exited with ${result.status}`);
  } finally {
    rmSync(keyFile, { force: true });
  }
}

function readResult(): Record<string, unknown> {
  const file = join(sandbox, "out", "result.json");
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).size > 200_000) throw new Error("The agent did not write a usable result");
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The agent result is not an object");
  return value;
}

function emit(result: object, patch?: Buffer): void {
  mkdirSync(resultDir, { recursive: true });
  // The model goes into the footer of whatever tidy posts.
  writeFileSync(join(resultDir, "result.json"), JSON.stringify({ ...result, model }));
  if (patch) writeFileSync(join(resultDir, "patch.diff"), patch);
  setOutput("result", "true");
}

// Arguments go to the command as a list, never through a shell, so only their shape is checked here.
function emitPlan(value: Record<string, unknown>): void {
  const runs: Record<string, string[]> = {};
  for (const [name, args] of Object.entries((value.runs ?? {}) as Record<string, unknown>)) {
    if (!meta.extras.includes(name)) continue;
    if (!Array.isArray(args) || args.length > 40 || !args.every((a) => typeof a === "string" && a.length <= 500 && !a.includes("\0"))) {
      console.error(`Ignoring invalid arguments for ${name}`);
      continue;
    }
    runs[name] = args;
  }
  mkdirSync(join(temp, "plan"), { recursive: true });
  writeFileSync(join(temp, "plan", "plan.json"), JSON.stringify({ runs }));
  setOutput("plan", "true");
}

const comment = (body: string) => emit({ type: "comment", body: sanitize(body) });

function finishFix(work: string, stash: string, value: Record<string, unknown>): void {
  for (const name of PROJECT_CONFIG) {
    rmSync(join(work, name), { recursive: true, force: true });
    if (existsSync(join(stash, name))) renameSync(join(stash, name), join(work, name));
  }
  if (value.implementation !== "prepared") {
    const reason = typeof value.reason === "string" && value.reason.trim() ? value.reason : "tidy could not prepare a fix for this issue.";
    return comment(`${reason}\n\n<sub>tidy did not change any files.</sub>`);
  }
  let title = typeof value.title === "string" ? singleLine(value.title, 100) : "";
  if (!TITLE.test(title)) title = `fix: ${title || `address issue #${meta.number}`}`.slice(0, 100);
  const body = typeof value.body === "string" && value.body.trim() ? value.body : "tidy prepared this change.";
  const git = {
    gitDir: join(temp, "patch.git"),
    workTree: work,
    indexFile: join(temp, "patch.index"),
  };
  rmSync(git.gitDir, { recursive: true, force: true });
  cpSync(join(context, "source.git"), git.gitDir, { recursive: true });
  try {
    const { patch } = buildPatch(git, meta.base, meta.config.protected_paths);
    emit({ type: "pr", title, body: sanitize(body) }, patch);
  } catch (error) {
    comment(`tidy prepared a change, but it failed the safety checks, so no pull request was opened:\n\n> ${(error as Error).message}`);
  }
}

async function main() {
  const { keys } = await requestCredentials("agent");
  if (!keys || Object.keys(keys).length === 0) throw new Error("No model keys are configured. Add one in the Worker's /admin page.");
  const { work, stash } = prepareSandbox();
  runContainer(work, keys);

  if (task === "triage") {
    const triage = parseTriage(readResult());
    const decision = route(meta.config, triage, meta.forceFix);
    console.log(`Triage: ${triage.kind}/${triage.size} → ${decision.action} ${decision.model}`);
    setOutput("action", decision.action);
    setOutput("model", decision.model);
    if (decision.action === "security-notice" && meta.config.security_notice) comment(meta.config.security_notice);
    return;
  }
  let value: Record<string, unknown>;
  try {
    value = readResult();
  } catch (error) {
    if (task === "fix") return comment(`tidy tried to fix this issue but did not finish: ${(error as Error).message}.`);
    throw error;
  }
  if (task === "fix") return finishFix(work, stash, value);
  if (task === "reply") {
    if (typeof value.body !== "string" || !value.body.trim()) throw new Error("The reply is empty");
    return comment(value.body);
  }
  if (task === "plan") return emitPlan(value);
  const review = validateReview(value, readFileSync(join(context, "diff.patch"), "utf8"));
  emit({ type: "review", ...review });
}

await main();
