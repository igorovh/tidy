// The only job that can write to the target repository. It runs no repository or agent code: it checks
// the artifact again and turns it into a comment, a review or a pull request on a new branch.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { clientPayload, env, notice } from "./lib/actions";
import { type Credentials, requestCredentials, type Target } from "./lib/credentials";
import { client, GitHubError, type GitHubClient } from "./lib/github";
import { applyPatch, git } from "./lib/patch";
import { ASSETS_BRANCH, storeAssets } from "./lib/assets";
import { commitMessage, thanks } from "./lib/attribution";
import { providerNotice } from "./lib/provider";
import { commentableLines, renderReview, type Review, validateReview, withSuggestion } from "./lib/review";
import { sanitize, singleLine } from "./lib/sanitize";
import { fetchSource } from "./lib/source";
import type { Meta } from "./gate";

const temp = env("RUNNER_TEMP");
const resultDir = join(temp, "result");
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:/-]+(#[a-z0-9-]+)?$/;
let FOOTER = footer();

function footer(model?: string): string {
  const by = model && MODEL.test(model) ? ` | Model: \`${model}\`` : "";
  return `\n\n---\n✨ Powered by [tidy](https://github.com/igorovh/tidy)${by}`;
}

type Fix = { type: "pr"; title: string; body: string; kind?: string };
type Result = { type: "comment"; body: string } | Fix | ({ type: "review" } & Review) | { type: "provider"; problem: string };


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

// Shows the patch on the issue instead of pushing it, because pushing would run CI with secrets on it.
async function proposeForApproval(gh: GitHubClient, meta: Meta, result: Fix, patch: Buffer) {
  const sha = createHash("sha256").update(patch).digest("hex");
  const text = patch.toString("utf8");
  const shown = text.length > 50_000 ? `${text.slice(0, 50_000)}\n… (truncated, ${patch.length} bytes in total)` : text;
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const workflows = meta.secretWorkflows.map((path) => `\`${path}\``).join(", ");
  const body = [
    `tidy prepared a fix: **${singleLine(result.title, 100)}**`,
    "",
    sanitize(result.body, 20_000),
    "",
    `This thread includes text from people without write access, and ${workflows} would run this change with repository secrets, so tidy has not pushed it. A maintainer can read the patch below and comment \`@tidy publish\` within 7 days to open the pull request.`,
    "",
    "<details><summary>Patch</summary>",
    "",
    `${fence}diff`,
    shown,
    fence,
    "",
    "</details>",
    "",
    `<!-- tidy:pending run=${env("GITHUB_RUN_ID")} sha=${sha} -->${FOOTER}`,
  ].join("\n");
  await gh.request(`/repos/${meta.repo}/issues/${meta.number}/comments`, { method: "POST", body: { body } });
}

async function openPullRequest(gh: GitHubClient, token: string, bot: string, meta: Meta, result: Fix) {
  const patch = readFileSync(join(resultDir, "patch.diff"));
  const approver = process.env.APPROVER;
  if (approver) {
    // `@tidy publish` approved one exact patch, named by its hash in tidy's comment.
    if (createHash("sha256").update(patch).digest("hex") !== env("PATCH_SHA")) {
      throw new Error("The patch does not match the one shown for approval");
    }
  } else if (!meta.trusted && meta.secretWorkflows.length > 0) {
    return proposeForApproval(gh, meta, result, patch);
  }
  const guarded = await protectedBranch(gh, meta);
  const protect = `\`bun run protect -- --repo ${meta.repo} --apply\` in your tidy repository`;
  if (!guarded && meta.config.require_ruleset) {
    await gh.request(`/repos/${meta.repo}/issues/${meta.number}/comments`, {
      method: "POST",
      body: {
        body: `tidy prepared a fix but did not push it: \`${meta.defaultBranch}\` has no ruleset that requires an approved pull request, and this tidy instance requires one. Run ${protect}, then comment \`@tidy fix\`.${FOOTER}`,
      },
    });
    return;
  }
  const unguarded = guarded
    ? ""
    : `\n\n> [!NOTE]\n> \`${meta.defaultBranch}\` does not require an approved pull request, so GitHub would not stop tidy from merging. tidy never does, but you can make it impossible: run ${protect}.`;
  // The patch must still apply to a commit that is part of the default branch's history.
  const compare = await gh.request<{ status: string }>(`/repos/${meta.repo}/compare/${meta.base}...${encodeURIComponent(meta.defaultBranch)}`);
  if (!["ahead", "identical"].includes(compare.status)) throw new Error(`Base ${meta.base} is no longer on ${meta.defaultBranch}`);

  const ctx = { gitDir: join(temp, "publish.git"), workTree: join(temp, "publish") };
  mkdirSync(ctx.workTree, { recursive: true });
  fetchSource(meta.repo, meta.base, token, ctx);
  const files = applyPatch(ctx, meta.base, patch, meta.config.protected_paths);

  const botUser = await gh.request<{ id: number }>(`/users/${encodeURIComponent(bot)}`);
  const title = singleLine(result.title, 100);
  const message = commitMessage(title, meta.number, meta.author, result.kind);
  const identity = ["-c", `user.name=${bot}`, "-c", `user.email=${botUser.id}+${bot}@users.noreply.github.com`, "-c", "commit.gpgsign=false"];
  git(ctx, [...identity, "commit", "--quiet", "--no-verify", "-F", "-"], message);
  const branch = `tidy/issue-${meta.number}-${env("GITHUB_RUN_ID")}-${env("GITHUB_RUN_ATTEMPT")}`;
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  // A fresh branch name per attempt; tidy never force-pushes or touches existing branches.
  git(ctx, ["-c", `http.extraheader=${auth}`, "push", "--quiet", `https://github.com/${meta.repo}.git`, `HEAD:refs/heads/${branch}`]);

  const approval = approver ? ` A maintainer, @​${approver}, approved publishing it.` : "";
  const origin = meta.trusted
    ? ""
    : `\n\n> [!WARNING]\n> This issue thread includes text from people without write access. Review the change, including scripts and dependencies.${approval}`;
  const pr = await gh.request<{ number: number; html_url: string }>(`/repos/${meta.repo}/pulls`, {
    method: "POST",
    body: {
      title,
      head: branch,
      base: meta.defaultBranch,
      body: `${sanitize(result.body)}${origin}${unguarded}\n\nChanged files: ${files.length}\n\n${thanks(meta.number, meta.author, result.kind)}\n\nCloses #${meta.number}${FOOTER}`,
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
  if (approver && process.env.PROPOSAL) {
    // Drop the marker so the same proposal cannot be published twice.
    await gh
      .request(`/repos/${meta.repo}/issues/comments/${process.env.PROPOSAL}`, {
        method: "PATCH",
        body: { body: `tidy published this change as ${pr.html_url}.${FOOTER}` },
      })
      .catch((error: Error) => notice(`Could not update the proposal comment: ${error.message}`));
  }
  if (!approver) {
    const summary = sanitize(result.body.split(/\n\s*\n/)[0] ?? "", 800);
    await gh.request(`/repos/${meta.repo}/issues/${meta.number}/comments`, {
      method: "POST",
      body: { body: `I opened #${pr.number} with a fix: **${title}**\n\n${summary}${FOOTER}` },
    });
  }
  notice(`Opened ${pr.html_url}`);
}

const MEDIA: Record<string, string> = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
// Files land on a branch in the reviewed repository, so each review gets a small budget.
const MAX_ATTACHMENT = 2 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_TOTAL = 10 * 1024 * 1024;
// GitHub rejects review bodies over 65,536 characters.
const MAX_REVIEW_BODY = 60_000;
// Pull request code chooses these names, and they end up in Markdown.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** Turns files written by review extras into Markdown, with a before and after per file. */
async function extrasSection(gh: GitHubClient, meta: Meta): Promise<string> {
  const root = join(temp, "checks", "extras");
  if (!existsSync(root)) return "";
  const folder = `${new Date().toISOString().slice(0, 10)}/pr-${meta.number}-${env("GITHUB_RUN_ID")}`;
  const sections: { title: string; before: string | null; after: string | null }[] = [];
  const files: { path: string; data: Buffer }[] = [];
  let total = 0;
  const pick = (dir: string, name: string, path: string) => {
    const file = join(dir, name);
    if (!existsSync(file) || !lstatSync(file).isFile()) return null;
    const size = lstatSync(file).size;
    if (size > MAX_ATTACHMENT || files.length >= MAX_ATTACHMENTS || total + size > MAX_ATTACHMENT_TOTAL) return "too-large";
    total += size;
    files.push({ path, data: readFileSync(file) });
    return path;
  };
  for (const extra of meta.config.review.extras) {
    const slug = extra.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const dirs = { before: join(root, slug, "before"), after: join(root, slug, "after") };
    const names = new Set(
      Object.values(dirs).flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => SAFE_NAME.test(f) && MEDIA[extname(f).toLowerCase()]) : [])),
    );
    for (const name of [...names].sort().slice(0, 4)) {
      sections.push({
        title: `${extra.name}${names.size > 1 ? `: \`${name}\`` : ""}`,
        before: pick(dirs.before, name, `${folder}/${slug}/before/${name}`),
        after: pick(dirs.after, name, `${folder}/${slug}/after/${name}`),
      });
    }
  }
  if (!sections.length) return "";
  let urls = new Map<string, string>();
  try {
    if (files.length) urls = await storeAssets(gh, meta.repo, files);
  } catch (error) {
    notice(`Could not store review files on ${ASSETS_BRANCH}: ${(error as Error).message}`);
  }
  const show = (path: string | null) => {
    if (!path) return "_not produced_";
    if (path === "too-large") return "_too large to attach (2 MB per file, 10 MB per review)_";
    const url = urls.get(path);
    if (!url) return "_could not attach_";
    return /\.(mp4|webm)$/i.test(path) ? url : `![${basename(path)}](${url})`;
  };
  return sections
    .map((s) => `### ${s.title}\n\n**Before** (\`${meta.defaultBranch}\`)\n\n${show(s.before)}\n\n**After** (this pull request)\n\n${show(s.after)}`)
    .join("\n\n");
}

async function postReview(gh: GitHubClient, meta: Meta, review: Review) {
  const pr = await gh.request<{ head: { sha: string } }>(`/repos/${meta.repo}/pulls/${meta.number}`);
  const stale = pr.head.sha !== meta.base;
  const extras = await extrasSection(gh, meta);
  let text = `${renderReview(review, { followUp: meta.followUp, extras })}${stale ? `\n\n_Reviewed commit ${meta.base.slice(0, 7)}; the pull request has changed since._` : ""}`;
  if (text.length > MAX_REVIEW_BODY) text = `${text.slice(0, MAX_REVIEW_BODY)}\n\n…(review shortened to fit GitHub's limit)`;
  const body = `${text}${FOOTER}`;
  const create = (comments: Review["comments"]) =>
    gh.request(`/repos/${meta.repo}/pulls/${meta.number}/reviews`, {
      method: "POST",
      // Always a comment: tidy never approves or requests changes, so it cannot satisfy a required review.
      body: {
        commit_id: meta.base,
        event: "COMMENT",
        body,
        comments: comments.map(({ suggestion, ...c }) => ({
          ...c,
          body: suggestion === undefined ? c.body : withSuggestion(c.body, suggestion),
          side: "RIGHT",
          ...(c.start_line ? { start_side: "RIGHT" } : {}),
        })),
      },
    });
  const rejected = (error: unknown) => {
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
  };
  try {
    return await create(stale ? [] : review.comments);
  } catch (error) {
    rejected(error);
  }
  // A follow-up diff can include lines from a merged base branch, which GitHub refuses comments on;
  // keep the comments that point at the pull request's own diff before dropping them all.
  try {
    const full = await gh.request<string>(`/repos/${meta.repo}/pulls/${meta.number}`, { accept: "application/vnd.github.diff" });
    const lines = commentableLines(full);
    const kept = review.comments.filter((c) => [c.start_line ?? c.line, c.line].every((n) => lines.get(c.path)?.has(n)));
    if (kept.length && kept.length < review.comments.length) return await create(kept);
  } catch (error) {
    rejected(error);
  }
  await create([]);
}

type Outcome = "posted" | "problem" | "nothing";

async function publish(gh: GitHubClient, credentials: Credentials): Promise<Outcome> {
  if (!existsSync(join(resultDir, "result.json"))) {
    // Artifacts are kept for 7 days, so an older approval has nothing left to publish.
    if (process.env.APPROVER) throw new Error("The approved patch has expired. Comment `@tidy fix` to prepare a new one.");
    return "nothing";
  }
  const meta = readJson<Meta>(join(temp, "context", "meta.json"), 1_000_000);
  const result = readJson<Result>(join(resultDir, "result.json"), 2_000_000);
  FOOTER = footer((result as { model?: string }).model);
  const { target } = credentials;
  // The Worker's record of the dispatch, not the artifact, says where this run may write.
  if (target.repo.toLowerCase() !== meta.repo.toLowerCase() || target.number !== meta.number) throw new Error("Artifact does not match the dispatch");

  if (result.type === "provider") {
    const retry = meta.task === "review" ? "@tidy review" : "@tidy fix";
    const body = providerNotice(result.problem, credentials.admin, clientPayload().worker, retry);
    await gh.request(`/repos/${meta.repo}/issues/${meta.number}/comments`, { method: "POST", body: { body: `${body}${FOOTER}` } });
    return "problem";
  }
  if (result.type === "comment") {
    await gh.request(`/repos/${meta.repo}/issues/${meta.number}/comments`, { method: "POST", body: { body: `${sanitize(result.body)}${FOOTER}` } });
  } else if (result.type === "review") {
    if (meta.task !== "review") throw new Error("Review result for a non-review dispatch");
    await postReview(gh, meta, validateReview(result, readFileSync(join(temp, "context", "diff.patch"), "utf8")));
  } else if (result.type === "pr") {
    if (meta.task !== "triage") throw new Error("Pull request result for a non-issue dispatch");
    if (process.env.APPROVER && target.kind !== "command") throw new Error("Approval needs a @tidy publish command");
    await openPullRequest(gh, credentials.token!, credentials.bot.login, meta, result);
  } else {
    throw new Error("Unknown result type");
  }
  return "posted";
}

async function react(gh: GitHubClient, target: Target, content: "rocket" | "confused" | null): Promise<void> {
  const subject = target.comment_id
    ? `/repos/${target.repo}/issues/comments/${target.comment_id}/reactions`
    : `/repos/${target.repo}/issues/${target.number}/reactions`;
  const quiet = (error: Error) => notice(`Could not update the reaction: ${error.message}`);
  if (target.reaction) await gh.request(`${subject}/${target.reaction}`, { method: "DELETE" }).catch(quiet);
  if (content) await gh.request(subject, { method: "POST", body: { content } }).catch(quiet);
}

// Always runs last: it swaps the 👀 the Worker added for 🚀, or reports a failure instead of staying silent.
async function main() {
  const credentials = await requestCredentials("write");
  const gh = client(credentials.token!);
  const { target } = credentials;
  const run = `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const report = (why: string) =>
    gh
      .request(`/repos/${target.repo}/issues/${target.number}/comments`, {
        method: "POST",
        body: { body: `${why} Nothing was changed. [See the run](${run}).${FOOTER}` },
      })
      .catch((error: Error) => notice(`Could not report the failure: ${error.message}`));
  let outcome: Outcome;
  try {
    outcome = await publish(gh, credentials);
  } catch (error) {
    const expired = (error as Error).message.startsWith("The approved patch has expired");
    await report(expired ? (error as Error).message : "tidy stopped because of an error while posting its answer.");
    await react(gh, target, "confused");
    throw error;
  }
  const failed = process.env.FAILED === "true" && outcome === "nothing";
  if (failed) await report("tidy stopped because of an error.");
  await react(gh, target, outcome === "posted" ? "rocket" : failed || outcome === "problem" ? "confused" : null);
}

await main();
