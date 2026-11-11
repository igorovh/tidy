export const KINDS = ["bug", "feature", "docs", "question", "spam", "security"] as const;
export const SIZES = ["small", "medium", "large"] as const;
export const ACTIONS = ["fix", "reply", "ignore", "security-notice"] as const;
export type Kind = (typeof KINDS)[number];
export type Size = (typeof SIZES)[number];
export type Action = (typeof ACTIONS)[number];

export interface Route {
  when: { kind?: Kind[]; size?: Size[] };
  action: Action;
  model?: string;
}

export interface Config {
  enabled: boolean;
  models: { allowed: string[] };
  triage: { model: string };
  routes: Route[];
  review: { model: string; deep_model: string; checks: string[]; image: string };
  agent: { opencode: string; image: string; timeout_minutes: number };
  limits: { outsider_attempts_per_day: number };
  protected_paths: string[];
  security_notice: string;
  require_ruleset: boolean;
}

const MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*(#[a-z0-9-]+)?$/;

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export function modelAllowed(config: Pick<Config, "models">, model: string): boolean {
  return MODEL.test(model) && config.models.allowed.some((pattern) => glob(pattern).test(model.split("#")[0]!));
}

function list<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => allowed.includes(item))) throw new Error(`${field} must be a list of ${allowed.join(", ")}`);
  return value as T[];
}

function parseRoutes(value: unknown): Route[] {
  if (!Array.isArray(value)) throw new Error("routes must be a list");
  return value.map((raw, index) => {
    const route = raw as { when?: { kind?: unknown; size?: unknown }; action?: unknown; model?: unknown };
    if (!ACTIONS.includes(route.action as Action)) throw new Error(`routes[${index}].action is invalid`);
    if (route.model !== undefined && typeof route.model !== "string") throw new Error(`routes[${index}].model must be a string`);
    return {
      when: { kind: list(route.when?.kind, KINDS, `routes[${index}].when.kind`), size: list(route.when?.size, SIZES, `routes[${index}].when.size`) },
      action: route.action as Action,
      ...(route.model ? { model: route.model } : {}),
    };
  });
}

export function parseInstance(raw: unknown): Config {
  const c = raw as Config;
  const config: Config = {
    enabled: c.enabled !== false,
    models: { allowed: c.models?.allowed ?? [] },
    triage: { model: c.triage?.model },
    routes: parseRoutes(c.routes ?? []),
    review: { model: c.review?.model, deep_model: c.review?.deep_model ?? c.review?.model, checks: c.review?.checks ?? [], image: c.review?.image ?? "node:22-bookworm" },
    agent: { opencode: c.agent?.opencode, image: c.agent?.image ?? "node:22-bookworm", timeout_minutes: c.agent?.timeout_minutes ?? 30 },
    limits: { outsider_attempts_per_day: c.limits?.outsider_attempts_per_day ?? 2 },
    protected_paths: c.protected_paths ?? [],
    security_notice: c.security_notice ?? "",
    require_ruleset: c.require_ruleset === true,
  };
  for (const model of [config.triage.model, config.review.model, config.review.deep_model, ...config.routes.map((r) => r.model)]) {
    if (model !== undefined && !modelAllowed(config, model)) throw new Error(`Model ${model} is not in models.allowed`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(config.agent.opencode ?? "")) throw new Error("agent.opencode must be an exact version");
  return config;
}

/**
 * Applies a repository's `.github/tidy.yml` from its default branch. Repositories may pick models and
 * routes inside the instance allowlist, add protected paths and lower limits, but cannot raise limits or change agent setup.
 */
export function mergeRepo(instance: Config, raw: unknown, warn: (message: string) => void = () => {}): Config {
  if (raw === null || raw === undefined) return instance;
  if (typeof raw !== "object") throw new Error(".github/tidy.yml must be a mapping");
  const repo = raw as Partial<{ enabled: unknown; triage: { model?: unknown }; routes: unknown; review: Record<string, unknown>; protected_paths: unknown; security_notice: unknown; limits: { outsider_attempts_per_day?: unknown } }>;
  const model = (value: unknown, fallback: string, field: string) => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && modelAllowed(instance, value)) return value;
    warn(`${field} ${String(value)} is not allowed by this tidy instance; using ${fallback}`);
    return fallback;
  };
  const routes = repo.routes === undefined ? instance.routes : parseRoutes(repo.routes);
  const checks = repo.review?.checks;
  if (checks !== undefined && !(Array.isArray(checks) && checks.every((c) => typeof c === "string" && c.length < 500))) {
    throw new Error("review.checks must be a list of commands");
  }
  const image = repo.review?.image;
  if (image !== undefined && !(typeof image === "string" && /^[a-z0-9][a-z0-9./:@_-]{0,200}$/.test(image))) {
    throw new Error("review.image is not a valid image reference");
  }
  return {
    ...instance,
    enabled: repo.enabled === undefined ? instance.enabled : repo.enabled !== false,
    triage: { model: model(repo.triage?.model, instance.triage.model, "triage.model") },
    routes: routes.map((route) => (route.model ? { ...route, model: model(route.model, instance.triage.model, "routes.model") } : route)),
    review: {
      model: model(repo.review?.model, instance.review.model, "review.model"),
      deep_model: model(repo.review?.deep_model, instance.review.deep_model, "review.deep_model"),
      checks: (checks as string[] | undefined) ?? instance.review.checks,
      image: (image as string | undefined) ?? instance.review.image,
    },
    protected_paths: [
      ...instance.protected_paths,
      ...(Array.isArray(repo.protected_paths) ? repo.protected_paths.filter((p): p is string => typeof p === "string") : []),
    ],
    security_notice: typeof repo.security_notice === "string" ? repo.security_notice : instance.security_notice,
    limits: {
      outsider_attempts_per_day:
        typeof repo.limits?.outsider_attempts_per_day === "number" && repo.limits.outsider_attempts_per_day >= 0
          ? Math.min(repo.limits.outsider_attempts_per_day, instance.limits.outsider_attempts_per_day)
          : instance.limits.outsider_attempts_per_day,
    },
  };
}

export interface Triage {
  kind: Kind;
  size: Size;
}

export function parseTriage(raw: unknown): Triage {
  const value = raw as Partial<Triage>;
  if (!value || !KINDS.includes(value.kind as Kind) || !SIZES.includes(value.size as Size)) throw new Error("Invalid triage result");
  return { kind: value.kind as Kind, size: value.size as Size };
}

/** First matching route wins; no match means tidy does nothing. */
export function route(config: Config, triage: Triage, forceFix: boolean): { action: Action; model: string } {
  const match = config.routes.find(
    (r) => (!r.when.kind || r.when.kind.includes(triage.kind)) && (!r.when.size || r.when.size.includes(triage.size)),
  );
  if (!match) return { action: "ignore", model: "" };
  // `@tidy fix` from a maintainer turns a reply into a fix, but never touches spam or security reports.
  if (forceFix && match.action === "reply") {
    const fix = config.routes.find((r) => r.action === "fix" && (!r.when.size || r.when.size.includes(triage.size)));
    return { action: "fix", model: fix?.model ?? config.triage.model };
  }
  return { action: match.action, model: match.model ?? config.triage.model };
}
