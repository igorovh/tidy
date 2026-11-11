/** Marks a patch tidy showed on an issue and a maintainer can publish with `@tidy publish`. */
export const PENDING = /<!-- tidy:pending run=(\d+) sha=([0-9a-f]{64}) -->/;

const PR_EVENTS = new Set(["pull_request", "pull_request_target", "workflow_run"]);

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/**
 * Workflows that could hand repository secrets to code on a tidy branch: they run for pull requests
 * and mention a secret other than GITHUB_TOKEN. Unparseable files count as risky.
 */
export function secretWorkflows(files: { path: string; text: string }[]): string[] {
  return files
    .filter(({ text }) => {
      const usesSecrets = /secrets\s*:\s*inherit|secrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]|secrets\[/.test(text);
      if (!usesSecrets) return false;
      try {
        const doc = Bun.YAML.parse(text) as Record<string, unknown> | null;
        // YAML 1.1 parsers read the `on` key as `true`.
        const on = doc?.on ?? doc?.[String(true)];
        return triggers(on).some((event) => PR_EVENTS.has(event));
      } catch {
        return true;
      }
    })
    .map(({ path }) => path);
}
