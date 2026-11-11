import { mkdirSync } from "node:fs";
import { git, type GitContext } from "./patch";

/** Checks out one commit into `workTree` with its git directory kept elsewhere, out of the agent's reach. */
export function fetchSource(repo: string, ref: string, token: string, ctx: GitContext): string {
  mkdirSync(ctx.workTree, { recursive: true });
  git(ctx, ["init", "--quiet"]);
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  git(ctx, ["-c", `http.extraheader=${auth}`, "fetch", "--quiet", "--depth=1", "--no-tags", `https://github.com/${repo}.git`, ref]);
  const sha = git(ctx, ["rev-parse", "FETCH_HEAD"]).toString().trim();
  git(ctx, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", sha]);
  return sha;
}
