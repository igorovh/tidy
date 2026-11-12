export type ProviderProblem = "usage" | "key";

// Matched against OpenCode's output only when a run produced no result, so a review that merely
// mentions "rate limit" in its code does not trip it.
const USAGE = /usage limit|quota|insufficient[ _](?:credit|balance|funds|quota)|credit balance|payment required|\b402\b|too many requests|\b429\b|rate[ _-]?limit|limit (?:reached|exceeded)|exceeded your/i;
const KEY = /invalid (?:api )?key|incorrect api key|unauthori[sz]ed|\b401\b|authentication (?:failed|error)|no api key|api key (?:is )?(?:missing|required)/i;

/** Recognises a model provider refusing tidy's key, which only the tidy admin can fix. */
export function providerProblem(output: string): ProviderProblem | null {
  if (USAGE.test(output)) return "usage";
  if (KEY.test(output)) return "key";
  return null;
}

/** Whether text contains any configured key, so a prompt injection cannot post one. */
export function leaksKey(text: string, keys: Record<string, string>): boolean {
  return Object.values(keys).some((key) => key.length >= 8 && text.includes(key));
}

/**
 * Tells the thread that the model provider refused tidy's key, and pings the instance admin, who is the
 * only one who can top up usage or replace the key. The text is tidy's own, not the model's.
 */
export function providerNotice(problem: string, admin: string | undefined, worker: string, retry: string): string {
  const cause =
    problem === "usage"
      ? "the model provider refused more requests, most likely because the plan's usage limit is used up"
      : "the model provider rejected tidy's key, or no key is set";
  const fix = problem === "usage" ? "check the usage on the provider's side, or add a key with more room," : "set a working key";
  const who = admin && /^[A-Za-z0-9-]{1,39}$/.test(admin) ? `@${admin}, please` : "The tidy admin can";
  return `tidy could not finish because ${cause}. Nothing was changed.\n\n${who} ${fix} in [the tidy admin page](${worker}/admin). Then comment \`${retry}\` to try again.`;
}
