import { matchesGlob } from "./config";

/** Marks a patch tidy showed on an issue and a maintainer can publish with `@tidy publish`. */
export const PENDING = /<!-- tidy:pending run=(\d+) sha=([0-9a-f]{64}) -->/;

const PR_EVENTS = new Set(["pull_request", "pull_request_target", "workflow_run"]);
// The shape of the branches tidy pushes; a push filter that matches it would run on them.
const TIDY_BRANCH = "tidy/issue-1-1-1";

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : []);

/** Whether `on.push` would run for a branch tidy pushes; GitHub applies the patterns in order, `!` excluding. */
export function pushReachesTidy(push: unknown): boolean {
  if (!push || typeof push !== "object") return true;
  const filter = push as Record<string, unknown>;
  if ("branches-ignore" in filter) return !strings(filter["branches-ignore"]).some((p) => matchesGlob(TIDY_BRANCH, p));
  if (!("branches" in filter)) return !("tags" in filter || "tags-ignore" in filter);
  let included = false;
  for (const pattern of strings(filter.branches)) {
    if (pattern.startsWith("!")) {
      if (matchesGlob(TIDY_BRANCH, pattern.slice(1))) included = false;
    } else if (matchesGlob(TIDY_BRANCH, pattern)) included = true;
  }
  return included;
}

/**
 * Workflows that could hand repository secrets to code on a tidy branch: they run for pull requests, or
 * for pushes to tidy's branches, and use a secret other than GITHUB_TOKEN or cloud OIDC. Unparseable
 * files count as risky.
 */
export function secretWorkflows(files: { path: string; text: string }[]): string[] {
  return files
    .filter(({ text }) => {
      const usesSecrets = /secrets\s*:\s*inherit|secrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]|secrets\[|id-token\s*:\s*write|permissions\s*:\s*write-all/.test(text);
      if (!usesSecrets) return false;
      try {
        const doc = Bun.YAML.parse(text) as Record<string, unknown> | null;
        // YAML 1.1 parsers read the `on` key as `true`.
        const on = doc?.on ?? doc?.[String(true)];
        const events = triggers(on);
        if (events.some((event) => PR_EVENTS.has(event))) return true;
        if (!events.includes("push")) return false;
        return pushReachesTidy(on && typeof on === "object" && !Array.isArray(on) ? (on as Record<string, unknown>).push : null);
      } catch {
        return true;
      }
    })
    .map(({ path }) => path);
}
