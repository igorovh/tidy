// Runs OpenCode inside a container that sees only the workspace, the snapshot and its output file.
// An issue runs triage and then the chosen action in this one job, so the model key is fetched once.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, setOutput } from "./lib/actions";
import { type Kind, parseTriage, route } from "./lib/config";
import { requestCredentials } from "./lib/credentials";
import { type AgentTask, PROJECT_CONFIG, sandboxConfig } from "./lib/opencode";
import { buildPatch } from "./lib/patch";
import { leaksKey, type ProviderProblem, providerProblem } from "./lib/provider";
import { validateReview } from "./lib/review";
import { sanitize, singleLine } from "./lib/sanitize";
import type { Meta } from "./gate";

const TITLE = /^(feat|fix|docs|refactor|perf|test|build|ci|chore|style|revert)(\([^\r\n)]{1,40}\))?!?: \S.{0,90}$/;

const temp = env("RUNNER_TEMP");
const job = env("TASK") as "issue" | "review" | "plan";
const context = join(temp, "context");
const meta = JSON.parse(readFileSync(join(context, "meta.json"), "utf8")) as Meta;
const sandbox = join(temp, "sandbox");
const resultDir = join(temp, "result");

interface Step {
  task: AgentTask;
  model: string;
  shell: boolean;
}

let keys: Record<string, string> = {};
// The model of the step that produced the result; it goes into the footer of whatever tidy posts.
let model = env("MODEL");

class ProviderError extends Error {
  constructor(readonly problem: ProviderProblem) {
    super(`The model provider refused the request (${problem})`);
  }
}

function prompt(step: Step): string {
  const shellNote = step.shell
    ? "You have a shell. Install dependencies and run the project's checks before you finish."
    : "You have no shell. Edit files only and say in the pull request body that no checks were run; CI will run them.";
  const read = (name: string) => readFileSync(join(env("TIDY_ROOT"), "prompts", `${name}.md`), "utf8");
  // Triage and plan only answer with JSON, so they need no writing style.
  const text = step.task === "triage" || step.task === "plan" ? read(step.task) : `${read(step.task)}\n${read("style")}`;
  const extras = meta.config.review.extras
    .filter((extra) => meta.extras.includes(extra.name))
    .map((extra) => `### ${extra.name}\n\nCommand: \`${extra.command.join(" ")}\` followed by your arguments.\n\n${extra.instructions}`)
    .join("\n\n");
  return text
    .replaceAll("{{repo}}", meta.repo)
    .replaceAll("{{number}}", String(meta.number))
    .replaceAll("{{shell}}", shellNote)
    .replaceAll("{{extras}}", extras)
    .replaceAll(
      "{{followup}}",
      meta.followUp
        ? "This is a follow-up review. /tidy/context/previous.md is your last review of this pull request, and diff.patch shows only the commits pushed since then. Put earlier findings these commits resolved in \"fixed\", and what is still open or new in \"findings\"."
        : "",
    );
}

function prepareSandbox(step: Step): { work: string; stash: string } {
  rmSync(sandbox, { recursive: true, force: true });
  const work = join(sandbox, "work");
  const stash = join(sandbox, "stash");
  mkdirSync(join(sandbox, "out"), { recursive: true });
  mkdirSync(join(sandbox, "context"), { recursive: true });
  mkdirSync(join(sandbox, "etc"), { recursive: true });
  mkdirSync(stash, { recursive: true });
  if (step.task === "triage") mkdirSync(work);
  else cpSync(join(context, "source"), work, { recursive: true, verbatimSymlinks: true });
  for (const name of PROJECT_CONFIG) if (existsSync(join(work, name))) renameSync(join(work, name), join(stash, name));
  for (const name of ["thread.md", "diff.patch", "previous.md"]) if (existsSync(join(context, name))) cpSync(join(context, name), join(sandbox, "context", name));
  const checks = join(temp, "checks", "checks.md");
  if (step.task === "review") writeFileSync(join(sandbox, "context", "checks.md"), existsSync(checks) ? readFileSync(checks) : "No checks are configured.\n");
  writeFileSync(join(sandbox, "context", "prompt.md"), prompt(step));
  writeFileSync(join(sandbox, "etc", "opencode.json"), JSON.stringify(sandboxConfig(step.task, step.shell), null, 2));
  return { work, stash };
}

/** Runs OpenCode and returns its output, which is printed too. */
function runContainer(step: Step, work: string): string {
  // The key file lives outside every mount and is deleted as soon as the container exits.
  const keyFile = join(temp, `keys-${process.pid}.env`);
  writeFileSync(keyFile, Object.entries(keys).map(([name, value]) => `${name}=${value}`).join("\n") + "\n");
  chmodSync(keyFile, 0o600);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const install = step.shell ? '"@opencode/cli@$OPENCODE_VERSION" bun' : '"@opencode/cli@$OPENCODE_VERSION"';
  const script = [
    "set -e",
    'mkdir -p "$HOME"',
    `npm install --global --no-fund --no-audit --loglevel=error ${install} > /dev/null`,
    'exec opencode run --standalone --auto -m "$MODEL" "$(cat /tidy/context/prompt.md)"',
  ].join("\n");
  const readOnly = step.task === "fix" ? "" : ":ro";
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
        "-e", `MODEL=${step.model}`, "-e", `OPENCODE_VERSION=${meta.config.agent.opencode}`,
        "-v", `${work}:/work${readOnly}`,
        "-v", `${join(sandbox, "context")}:/tidy/context:ro`,
        "-v", `${join(sandbox, "out")}:/tidy/out`,
        "-v", `${join(sandbox, "etc")}:/etc/opencode:ro`,
        "-w", "/work",
        meta.config.agent.image,
        "bash", "-c", script,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: meta.config.agent.timeout_minutes * 60_000 },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(output);
    if (result.error) console.error(`Agent container stopped: ${result.error.message}`);
    else if (result.status !== 0) console.error(`Agent container exited with ${result.status}`);
    return output;
  } finally {
    rmSync(keyFile, { force: true });
  }
}

const resultFile = () => join(sandbox, "out", "result.json");
const hasResult = () => existsSync(resultFile()) && lstatSync(resultFile()).isFile();

/** Runs one step; a provider refusal with no result becomes a ProviderError for the admin. */
function runStep(step: Step): { work: string; stash: string } {
  model = step.model;
  const paths = prepareSandbox(step);
  const output = runContainer(step, paths.work);
  const problem = hasResult() ? null : providerProblem(output);
  if (problem) throw new ProviderError(problem);
  return paths;
}

function readResult(): Record<string, unknown> {
  if (!hasResult() || lstatSync(resultFile()).size > 200_000) throw new Error("The agent did not write a usable result");
  const text = readFileSync(resultFile(), "utf8");
  if (leaksKey(text, keys)) throw new Error("The agent's result contained a model key, so it was discarded");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The agent result is not an object");
  return value;
}

function emit(result: object, patch?: Buffer): void {
  const json = JSON.stringify({ ...result, model });
  if (leaksKey(json, keys) || (patch && leaksKey(patch.toString("utf8"), keys))) throw new Error("The output contained a model key, so it was discarded");
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(join(resultDir, "result.json"), json);
  if (patch) writeFileSync(join(resultDir, "patch.diff"), patch);
  setOutput("result", "true");
}

// Arguments go to the command as a list, never through a shell, so only their shape is checked here.
function emitPlan(value: Record<string, unknown>): void {
  const runs: Record<string, string[]> = {};
  for (const [given, args] of Object.entries((value.runs ?? {}) as Record<string, unknown>)) {
    // Models often change the case of a name, so match it loosely and store the configured one.
    const name = meta.extras.find((extra) => extra.toLowerCase() === given.trim().toLowerCase());
    if (!name) {
      console.error(`Ignoring arguments for unknown extra ${given}`);
      continue;
    }
    if (!Array.isArray(args) || args.length > 40 || !args.every((a) => typeof a === "string" && a.length <= 500 && !a.includes("\0"))) {
      console.error(`Ignoring invalid arguments for ${name}`);
      continue;
    }
    runs[name] = args;
  }
  if (leaksKey(JSON.stringify(runs), keys)) throw new Error("The plan contained a model key, so it was discarded");
  mkdirSync(join(temp, "plan"), { recursive: true });
  writeFileSync(join(temp, "plan", "plan.json"), JSON.stringify({ runs }));
  setOutput("plan", "true");
}

const comment = (body: string) => emit({ type: "comment", body: sanitize(body) });

function finishFix(work: string, stash: string, value: Record<string, unknown>, kind: Kind): void {
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
  // tidy lays out the description, so every pull request reads the same way.
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : []);
  const section = (title: string, entries: string[]) => (entries.length ? `**${title}**\n${entries.map((e) => `- ${e.replace(/\s*\n\s*/g, " ")}`).join("\n")}` : "");
  const why = typeof value.why === "string" ? value.why.trim() : "";
  const body =
    [why, section("What changed", list(value.changes)), section("Checks", list(value.checks))].filter(Boolean).join("\n\n") ||
    "tidy prepared this change.";
  const git = {
    gitDir: join(temp, "patch.git"),
    workTree: work,
    indexFile: join(temp, "patch.index"),
  };
  rmSync(git.gitDir, { recursive: true, force: true });
  cpSync(join(context, "source.git"), git.gitDir, { recursive: true });
  let patch: Buffer;
  try {
    patch = buildPatch(git, meta.base, meta.config.protected_paths).patch;
  } catch (error) {
    return comment(`tidy prepared a change, but it failed the safety checks, so no pull request was opened:\n\n> ${(error as Error).message}`);
  }
  // The kind decides how the commit credits the issue author (Reported-by or Suggested-by).
  emit({ type: "pr", title, body: sanitize(body), kind }, patch);
}

async function handleIssue(): Promise<void> {
  runStep({ task: "triage", model: env("MODEL"), shell: false });
  const triage = parseTriage(readResult());
  const decision = route(meta.config, triage, meta.forceFix);
  console.log(`Triage: ${triage.kind}/${triage.size} → ${decision.action} ${decision.model}`);
  if (decision.action === "security-notice") {
    if (meta.config.security_notice) comment(meta.config.security_notice);
    return;
  }
  if (decision.action === "ignore") return;
  const shell = decision.action === "fix" && meta.trusted && env("SHELL_ALLOWED") === "true";
  const { work, stash } = runStep({ task: decision.action, model: decision.model, shell });
  let value: Record<string, unknown>;
  try {
    value = readResult();
  } catch (error) {
    return comment(`tidy tried to ${decision.action === "fix" ? "fix" : "answer"} this issue but did not finish: ${(error as Error).message}.`);
  }
  if (decision.action === "fix") return finishFix(work, stash, value, triage.kind);
  if (typeof value.body !== "string" || !value.body.trim()) throw new Error("The reply is empty");
  comment(value.body);
}

async function main() {
  keys = (await requestCredentials("agent")).keys ?? {};
  try {
    if (Object.keys(keys).length === 0) throw new ProviderError("key");
    if (job === "issue") return await handleIssue();
    runStep({ task: job, model, shell: false });
    const value = readResult();
    if (job === "plan") return emitPlan(value);
    emit({ type: "review", ...validateReview(value, readFileSync(join(context, "diff.patch"), "utf8")) });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    console.error(error.message);
    // Without a plan the review still runs, and reports the same problem if it persists.
    if (job === "plan") return;
    // publish tells the thread and pings the admin; only they can top up usage or replace the key.
    rmSync(resultDir, { recursive: true, force: true });
    emit({ type: "provider", problem: error.problem });
  }
}

await main();
