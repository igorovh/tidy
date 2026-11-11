// The only job that can write to the target repository. It runs no repository or agent code: it checks
// the artifact again and turns it into a comment, a review or a pull request on a new branch.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { env, notice } from "./lib/actions";
import { requestCredentials } from "./lib/credentials";
import { client, GitHubError, type GitHubClient } from "./lib/github";
import { applyPatch, git } from "./lib/patch";
import { type Review, validateReview } from "./lib/review";
import { sanitize, singleLine } from "./lib/sanitize";
import { fetchSource } from "./lib/source";
import type { Meta } from "./gate";

const temp = env("RUNNER_TEMP");
const resultDir = join(temp, "result");
const FOOTER = "\n\n<sub>Written by tidy, an AI agent. It can be wrong; a maintainer decides what to merge.</sub>";

type Result = { type: "comment"; body: string } | { type: "pr"; title: string; body: string } | ({ type: "review" } & Review);

function readJson<T>(file: string, limit: number): T {
  if (!existsSync(file) || statSync(file).size > limit) throw new Error(`Missing or oversized ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function protectedBranch(gh: GitHubClient, meta: Meta): Promise<boolean> {
  const rules = await gh.request<{ type: string; parameters?: { required_approving_review_count?: number } }[]>(
    `/repos/${meta.repo}/rules/branches/${encodeURIComponent(meta.defaultBranch)}`,
  );
  return rules.some((rule) => rule.type === "pull_request" && (rule.parameters?.required_approving_review_count ?? 0) >= 1);
}

async function openPullRequest(gh: GitHubClient, token: string, bot: string, meta: Meta, result: { title: string; body: string }) {
  if (!(await protectedBranch(gh, meta))) {
    await gh.request(`/repos/${meta.repo}/issues/${meta.number}/comments`, {
      method: "POST",
      body: {
        body: `tidy prepared a fix but did not push it: \`${meta.defaultBranch}\` has no ruleset that requires an approved pull request, so tidy's write access would not be limited to proposals. Import \`rulesets/default-branch.json\` from the tidy repository, then comment \`@tidy fix\`.${FOOTER}`,
      },
    });
    return;
  }
  // The patch must still apply to a commit that is part of the default branch's history.
  const compare = await gh.request<{ status: string }>(`/repos/${meta.repo}/compare/${meta.base}...${encodeURIComponent(meta.defaultBranch)}`);
  if (!["ahead", "identical"].includes(compare.status)) throw new Error(`Base ${meta.base} is no longer on ${meta.defaultBranch}`);

  const ctx = { gitDir: join(temp, "publish.git"), workTree: join(temp, "publish") };
  mkdirSync(ctx.workTree, { recursive: true });
  fetchSource(meta.repo, meta.base, token, ctx);
  const files = applyPatch(ctx, meta.base, readFileSync(join(resultDir, "patch.diff")), meta.config.protected_paths);

  const botUser = await gh.request<{ id: number }>(`/users/${encodeURIComponent(bot)}`);
  const title = singleLine(result.title, 100);
  const message = [
    title,
    "",
    `Closes #${meta.number}`,
    "",
    `Co-authored-by: ${meta.author.login} <${meta.author.id}+${meta.author.login}@users.noreply.github.com>`,
  ].join("\n");
  const identity = ["-c", `user.name=${bot}`, "-c", `user.email=${botUser.id}+${bot}@users.noreply.github.com`, "-c", "commit.gpgsign=false"];
  git(ctx, [...identity, "commit", "--quiet", "--no-verify", "-F", "-"], message);
  // Repositories can keep secret-bearing CI jobs off `tidy/untrusted/` branches (see README).
  const prefix = meta.trusted ? "tidy" : "tidy/untrusted";
  const branch = `${prefix}/issue-${meta.number}-${env("GITHUB_RUN_ID")}-${env("GITHUB_RUN_ATTEMPT")}`;
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  // A fresh branch name per attempt; tidy never force-pushes or touches existing branches.
  git(ctx, ["-c", `http.extraheader=${auth}`, "push", "--quiet", `https://github.com/${meta.repo}.git`, `HEAD:refs/heads/${branch}`]);

  const origin = meta.trusted ? "" : "\n\n> [!WARNING]\n> This issue thread includes text from people without write access. Review the change, including scripts and dependencies, before letting CI run it with secrets.";
  const pr = await gh.request<{ number: number; html_url: string }>(`/repos/${meta.repo}/pulls`, {
    method: "POST",
    body: {
      title,
      head: branch,
      base: meta.defaultBranch,
      body: `${sanitize(result.body)}${origin}\n\nChanged files: ${files.length}\n\nCloses #${meta.number}${FOOTER}`,
      draft: false,
    },
  });
  try {
    await gh.request(`/repos/${meta.repo}/issues/${pr.number}/labels`, {
      method: "POST",
      body: { labels: meta.trusted ? ["tidy"] : ["tidy", "tidy: untrusted"] },
    });
  } catch (error) {
    notice(`Could not label ${pr.html_url}: ${(error as Error).message}`);
  }
  notice(`Opened ${pr.html_url}`);
}

async function postReview(gh: GitHubClient, meta: Meta, review: Review) {
  const pr = await gh.request<{ head: { sha: string } }>(`/repos/${meta.repo}/pulls/${meta.number}`);
  const stale = pr.head.sha !== meta.base;
  const body = `${review.summary}${stale ? `\n\n_Reviewed commit ${meta.base.slice(0, 7)}; the pull request has changed since._` : ""}${FOOTER}`;
  const create = (comments: Review["comments"]) =>
    gh.request(`/repos/${meta.repo}/pulls/${meta.number}/reviews`, {
      method: "POST",
      // Always a comment: tidy never approves or requests changes, so it cannot satisfy a required review.
      body: { commit_id: meta.base, event: "COMMENT", body, comments: comments.map((c) => ({ ...c, side: "RIGHT" })) },
    });
  try {
    await create(stale ? [] : review.comments);
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
    await create([]);
  }
}

async function main() {
  if (!existsSync(join(resultDir, "result.json"))) {
    notice("Nothing to publish");
    return;
  }
  const meta = readJson<Meta>(join(temp, "context", "meta.json"), 1_000_000);
  const result = readJson<Result>(join(resultDir, "result.json"), 2_000_000);
  const credentials = await requestCredentials("write");
  const { target } = credentials;
  // The Worker's record of the dispatch, not the artifact, says where this run may write.
  if (target.repo.toLowerCase() !== meta.repo.toLowerCase() || target.number !== meta.number) throw new Error("Artifact does not match the dispatch");
  const gh = client(credentials.token!);

  if (result.type === "comment") {
    await gh.request(`/repos/${meta.repo}/issues/${meta.number}/comments`, { method: "POST", body: { body: `${sanitize(result.body)}${FOOTER}` } });
  } else if (result.type === "review") {
    if (meta.task !== "review") throw new Error("Review result for a non-review dispatch");
    await postReview(gh, meta, validateReview(result, readFileSync(join(temp, "context", "diff.patch"), "utf8")));
  } else if (result.type === "pr") {
    if (meta.task !== "triage") throw new Error("Pull request result for a non-issue dispatch");
    await openPullRequest(gh, credentials.token!, credentials.bot.login, meta, result);
  } else {
    throw new Error("Unknown result type");
  }
}

await main();
