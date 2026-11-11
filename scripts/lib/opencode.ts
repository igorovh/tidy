export type AgentTask = "triage" | "fix" | "reply" | "review" | "plan";

type Statement = { action: string; resource: string; effect: "allow" | "deny" };

/**
 * System-level OpenCode config for the sandbox. Policies at this level outrank anything the checked-out
 * repository ships, and the last matching statement wins, so we deny everything and lift what the task needs.
 */
export function sandboxConfig(task: AgentTask, shell: boolean): object {
  const tool = (resource: string, effect: Statement["effect"]): Statement => ({ action: "tool.use", resource, effect });
  const policies: Statement[] = [
    tool("*", "deny"),
    tool("edit:/tidy/out/result.json", "allow"),
    tool("external_directory:/tidy/*", "allow"),
  ];
  if (task !== "triage") policies.push(tool("read:*", "allow"), tool("glob:*", "allow"), tool("grep:*", "allow"));
  else policies.push(tool("read:/tidy/context/thread.md", "allow"));
  if (task === "fix") policies.push(tool("edit:*", "allow"), tool("subagent:*", "allow"));
  if (task === "fix" && shell) policies.push(tool("shell:*", "allow"));
  // Repository config can point a provider at another endpoint, which would leak the model key.
  policies.push(
    tool("edit:*opencode.json*", "deny"),
    tool("edit:*.opencode/*", "deny"),
    tool("edit:/tidy/context/*", "deny"),
    { action: "mcp.use", resource: "*", effect: "deny" },
    { action: "skill.use", resource: "*", effect: "deny" },
    { action: "plugin.use", resource: "*", effect: "deny" },
    { action: "websearch.use", resource: "*", effect: "deny" },
  );
  return {
    $schema: "https://opencode.ai/config.json",
    permissions: [
      { action: "question", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ],
    policies,
  };
}

/** Files OpenCode would load as project configuration; moved out of the sandbox for the run. */
export const PROJECT_CONFIG = ["opencode.json", "opencode.jsonc", ".opencode"];
