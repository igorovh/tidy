/** Run limits the Worker enforces before it starts a workflow. Set them under `limits:` in tidy.yml. */
export interface RunLimits {
  /** Workflow runs per UTC day across the instance, for everyone. */
  runs_per_day: number;
  /** Workflow runs per UTC day in one repository, for everyone. */
  runs_per_repo_per_day: number;
  /** Events (issues, pull requests, pushes) per UTC day from one person without write access. */
  outsider_events_per_day: number;
  /** Follow-up reviews per UTC day on one pull request by someone without write access. */
  outsider_pushes_per_pr_per_day: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  runs_per_day: 300,
  runs_per_repo_per_day: 100,
  outsider_events_per_day: 10,
  outsider_pushes_per_pr_per_day: 6,
};

/**
 * Reads the numbers under a top-level `limits:` key. The Worker has no YAML parser, so this covers only
 * the flat `key: number` form tidy.yml uses; anything it cannot read keeps its default.
 */
export function parseLimits(yaml: string): RunLimits {
  const limits = { ...DEFAULT_LIMITS };
  let inside = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inside = /^limits:\s*(#.*)?$/.test(line);
      continue;
    }
    const match = inside && line.match(/^\s+([a-z_]+):\s*(\d+)\s*(#.*)?$/);
    if (match && match[1]! in limits) limits[match[1] as keyof RunLimits] = Number(match[2]);
  }
  return limits;
}
