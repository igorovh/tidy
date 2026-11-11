// Adds tidy's ruleset to repositories you pick, using your own `gh` login.
//   bun run protect                                  interactive picker
//   bun run protect -- --repo you/app [--apply]      one or more repositories, no prompts
import { autocompleteMultiselect, cancel, confirm, intro, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RENOVATE_APP_ID = 2740;
const PARALLEL = 8;
const root = join(import.meta.dir, "..");
const template = JSON.parse(readFileSync(join(root, "rulesets", "default-branch.json"), "utf8"));
const args = process.argv.slice(2);
const named = args.flatMap((arg, i) => (arg === "--repo" && args[i + 1] ? [args[i + 1]!] : []));

function run(command: string, argv: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end(input);
  });
}

async function gh<T>(path: string, init: { method?: string; body?: unknown; paginate?: boolean; raw?: boolean } = {}): Promise<T> {
  const argv = ["api", path, "-H", `Accept: application/vnd.github${init.raw ? ".raw" : "+json"}`];
  if (init.paginate) argv.push("--paginate", "--slurp");
  if (init.method) argv.push("-X", init.method);
  if (init.body) argv.push("--input", "-");
  const { code, out } = await run("gh", argv, init.body ? JSON.stringify(init.body) : undefined);
  if (code !== 0) throw new Error(out.trim().split("\n")[0]);
  if (init.raw) return out as T;
  const parsed = JSON.parse(out || "null");
  return (init.paginate ? (parsed as unknown[][]).flat() : parsed) as T;
}

async function parallel<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
}

/** Repositories the App is installed on, asked from your Worker; null when that is not possible. */
async function installedRepos(): Promise<Set<string> | null> {
  const file = join(root, ".tidy.json");
  const worker = process.env.TIDY_WORKER ?? (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).worker : undefined);
  if (!worker) return null;
  const { code, out } = await run("gh", ["auth", "token"]);
  if (code !== 0) return null;
  try {
    const response = await fetch(`${worker}/api/repos`, { headers: { authorization: `Bearer ${out.trim()}` } });
    if (!response.ok) return null;
    return new Set(((await response.json()) as { repos: string[] }).repos.map((r) => r.toLowerCase()));
  } catch {
    return null;
  }
}

type Repo = { full_name: string; fork: boolean; archived: boolean; private: boolean; default_branch: string };
type Plan = { repo: Repo; action: "add" | "ok" | "skip"; detail: string; ruleset?: object };

async function renovateAutomerges(repo: string): Promise<boolean> {
  const files = ["renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json", ".github/renovate.json", ".github/renovate.json5"];
  for (const file of files) {
    const text = await gh<string>(`repos/${repo}/contents/${file}`, { raw: true }).catch(() => "");
    if (/["']?automerge["']?\s*:\s*true/.test(text)) return true;
  }
  return false;
}

async function plan(repo: Repo): Promise<Plan> {
  const name = repo.full_name;
  try {
    const rulesets = await gh<{ name: string }[]>(`repos/${name}/rulesets`);
    if (rulesets.some((r) => r.name === template.name)) return { repo, action: "ok", detail: "already has tidy's ruleset" };
    const rules = await gh<{ type: string; parameters?: { required_approving_review_count?: number } }[]>(
      `repos/${name}/rules/branches/${encodeURIComponent(repo.default_branch)}`,
    );
    if (rules.some((r) => r.type === "pull_request" && (r.parameters?.required_approving_review_count ?? 0) >= 1)) {
      return { repo, action: "ok", detail: "already requires an approval" };
    }
    const ruleset = structuredClone(template);
    const renovate = await renovateAutomerges(name);
    if (renovate) ruleset.bypass_actors.push({ actor_id: RENOVATE_APP_ID, actor_type: "Integration", bypass_mode: "always" });
    return { repo, action: "add", detail: renovate ? "add, with a bypass for Renovate automerge" : "add", ruleset };
  } catch (error) {
    const hint = repo.private ? " (rulesets on private repositories need GitHub Pro)" : "";
    return { repo, action: "skip", detail: `${(error as Error).message}${hint}` };
  }
}

function summary(plans: Plan[]): string {
  const icon = { add: "+", ok: "✓", skip: "!" } as const;
  return plans.map((p) => `${icon[p.action]} ${p.repo.full_name}  ${p.detail}`).join("\n");
}

async function applyAll(plans: Plan[]): Promise<void> {
  const results = await parallel(
    plans.filter((p) => p.action === "add"),
    async (p) => gh(`repos/${p.repo.full_name}/rulesets`, { method: "POST", body: p.ruleset }).then(() => null, (e: Error) => `${p.repo.full_name}: ${e.message}`),
  );
  const failed = results.filter((r): r is string => r !== null);
  for (const failure of failed) log.error(failure);
  log.success(`Added the ruleset to ${results.length - failed.length} repositories.`);
}

async function main() {
  if (named.length) {
    const plans = await parallel(named, async (name) => plan(await gh<Repo>(`repos/${name}`)));
    console.log(summary(plans));
    if (args.includes("--apply")) await applyAll(plans);
    else if (plans.some((p) => p.action === "add")) console.log("\nRun again with --apply to add the ruleset.");
    return;
  }

  intro("tidy protect");
  const s = spinner();
  s.start("Loading your repositories");
  const [owned, installed] = await Promise.all([
    gh<Repo[]>("user/repos?affiliation=owner&per_page=100", { paginate: true }),
    installedRepos(),
  ]);
  const repos = owned.filter((r) => !r.fork && !r.archived).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const hasTidy = (r: Repo) => installed?.has(r.full_name.toLowerCase()) ?? false;
  s.stop(`${repos.length} repositories${installed ? `, tidy is installed on ${repos.filter(hasTidy).length}` : ""}`);
  if (!installed) log.warn("Could not ask your Worker where tidy is installed. Run `bun run deploy` first, or set TIDY_WORKER.");

  const mode = await select({
    message: "Which repositories should get the ruleset?",
    options: [
      ...(installed ? [{ value: "installed", label: "Every repository tidy is installed on", hint: `${repos.filter(hasTidy).length}` }] : []),
      { value: "all", label: "All my repositories", hint: `${repos.length}` },
      { value: "pick", label: "Let me pick", hint: "type to filter, space to select" },
    ],
  });
  if (isCancel(mode)) return cancel("Nothing changed.");

  let chosen: Repo[];
  if (mode === "pick") {
    const picked = await autocompleteMultiselect({
      message: "Pick repositories",
      placeholder: "Type to filter…",
      required: true,
      maxItems: 15,
      initialValues: repos.filter(hasTidy).map((r) => r.full_name),
      options: repos.map((r) => ({
        value: r.full_name,
        label: r.full_name,
        hint: [installed ? (hasTidy(r) ? "tidy installed" : "not installed") : "", r.private ? "private" : ""].filter(Boolean).join(", "),
      })),
    });
    if (isCancel(picked)) return cancel("Nothing changed.");
    chosen = repos.filter((r) => picked.includes(r.full_name));
  } else {
    chosen = mode === "installed" ? repos.filter(hasTidy) : repos;
  }

  s.start(`Checking ${chosen.length} repositories`);
  const plans = await parallel(chosen, plan);
  s.stop("Checked");
  note(summary(plans), "Plan");
  const count = plans.filter((p) => p.action === "add").length;
  if (!count) return outro("Nothing to add.");
  const go = await confirm({ message: `Add the ruleset to ${count} repositories?`, initialValue: false });
  if (isCancel(go) || !go) return cancel("Nothing changed.");
  await applyAll(plans);
  outro("Done. Admins can still merge their own pull requests.");
}

await main();
