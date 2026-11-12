import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMITS, parseLimits } from "../shared/limits";
import { leaksKey, providerNotice, providerProblem } from "../scripts/lib/provider";
import { sandboxConfig } from "../scripts/lib/opencode";

describe("limits in tidy.yml", () => {
  test("the Worker's small parser reads the shipped tidy.yml the same way a YAML parser does", () => {
    const text = readFileSync(join(import.meta.dir, "..", "tidy.yml"), "utf8");
    const full = (Bun.YAML.parse(text) as { limits: Record<string, number> }).limits;
    const parsed = parseLimits(text);
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) expect(parsed[key]).toBe(full[key]!);
  });

  test("missing or unreadable values keep their defaults", () => {
    expect(parseLimits("limits:\n  runs_per_day: lots\nother:\n  runs_per_repo_per_day: 1\n")).toEqual(DEFAULT_LIMITS);
    expect(parseLimits("limits:  # caps\n  runs_per_day: 50  # fewer\n").runs_per_day).toBe(50);
  });
});

describe("model provider problems", () => {
  test("usage limits and rejected keys are told apart", () => {
    expect(providerProblem("APIError: 429 Too Many Requests: monthly usage limit reached")).toBe("usage");
    expect(providerProblem("Error: 401 Unauthorized: invalid api key")).toBe("key");
    expect(providerProblem("Agent container exited with 1")).toBeNull();
  });

  test("the notice pings the admin and says how to retry", () => {
    const text = providerNotice("usage", "igorovh", "https://tidy.example.workers.dev", "@tidy review");
    expect(text).toContain("@igorovh, please");
    expect(text).toContain("(https://tidy.example.workers.dev/admin)");
    expect(text).toContain("`@tidy review`");
    expect(providerNotice("key", "bad name!", "https://w", "@tidy fix")).toContain("The tidy admin can");
  });

  test("output containing a model key is caught", () => {
    expect(leaksKey('{"summary":"sk-1234567890abcdef"}', { OPENCODE_API_KEY: "sk-1234567890abcdef" })).toBe(true);
    expect(leaksKey('{"summary":"fine"}', { OPENCODE_API_KEY: "sk-1234567890abcdef" })).toBe(false);
  });

  test("the sandbox denies the process filesystems after every lift", () => {
    const policies = (sandboxConfig("review", false) as { policies: { resource: string; effect: string }[] }).policies;
    const lastAllow = policies.map((p) => p.effect).lastIndexOf("allow");
    const proc = policies.findIndex((p) => p.resource === "read:/proc/*" && p.effect === "deny");
    expect(proc).toBeGreaterThan(lastAllow);
  });
});
