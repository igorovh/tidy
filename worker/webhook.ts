import { b64url, timingSafeEqual, utf8 } from "../shared/encoding";
import { DEFAULT_LIMITS, parseLimits, type RunLimits } from "../shared/limits";
import type { AppRecord, Dispatch, Env, Instance } from "./env";
import { stateOf } from "./env";
import { github, installationToken } from "./github";
import { loadInstance, resolveRepo } from "./instance";

export async function signatureMatches(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(body)));
  const hex = header.slice(7);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const given = new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
  return timingSafeEqual(expected, given);
}

interface Payload {
  action?: string;
  installation?: { id: number };
  repository?: { id: number; full_name: string; owner?: { login: string } };
  sender?: { login: string; type: string };
  issue?: { number: number; pull_request?: unknown; state: string; author_association?: string };
  comment?: { id: number; body: string; user: { type: string }; author_association?: string };
  pull_request?: { number: number; draft: boolean; author_association?: string };
  label?: { name: string };
}

/** Adding this label asks tidy to review a pull request it would skip, such as one from Renovate. */
export const REVIEW_LABEL = "tidy:review";

// GitHub's own view of someone's relation to the repository; the gate checks write access again.
const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type Match = Omit<Dispatch, "installationId"> & { trusted: boolean; sender: string };

/** Decides from the event alone whether a run is worth starting; everything else happens in Actions. */
export function classify(event: string, payload: Payload, botLogin: string, tidyRepo: string): Match | null {
  const repo = payload.repository;
  if (!repo || !payload.installation || !payload.sender) return null;
  if (repo.full_name.toLowerCase() === tidyRepo.toLowerCase()) return null;
  const sender = payload.sender.login;
  const ours = sender === botLogin;
  const owner = sender.toLowerCase() === repo.owner?.login.toLowerCase();
  const trusted = (association?: string) => ours || owner || MAINTAINERS.has(association ?? "");
  const base = { repo: repo.full_name, repoId: repo.id, sender };
  if (event === "issues" && payload.action === "opened" && payload.issue && payload.sender.type !== "Bot") {
    return { ...base, kind: "issue", number: payload.issue.number, trusted: trusted(payload.issue.author_association) };
  }
  if (event === "issue_comment" && payload.action === "created" && payload.issue && payload.comment) {
    if (payload.sender.type === "Bot" || payload.comment.user.type === "Bot") return null;
    if (!new RegExp(`^\\s*@(tidy|${botLogin.replace(/\[bot\]$/, "")})\\b`, "i").test(payload.comment.body)) return null;
    // Only maintainers can run commands, so others are dropped here instead of using up a run.
    if (!trusted(payload.comment.author_association)) return null;
    return { ...base, kind: "command", number: payload.issue.number, commentId: payload.comment.id, trusted: true };
  }
  if (event === "pull_request" && payload.pull_request && !payload.pull_request.draft) {
    // Labelling needs triage access, so a labelled request counts like a maintainer's command.
    if (payload.action === "labeled") {
      if (payload.label?.name !== REVIEW_LABEL) return null;
      return { ...base, kind: "review", number: payload.pull_request.number, requested: true, trusted: true };
    }
    if (!["opened", "reopened", "ready_for_review", "synchronize"].includes(payload.action ?? "")) return null;
    // Other bots (Renovate, Dependabot) are skipped; tidy's own PRs still get a review.
    if (payload.sender.type === "Bot" && !ours) return null;
    // New commits get a follow-up review of just those commits; the gate checks the repository allows it.
    const followUp = payload.action === "synchronize" ? { followUp: true } : {};
    return { ...base, kind: "review", number: payload.pull_request.number, ...followUp, trusted: trusted(payload.pull_request.author_association) };
  }
  return null;
}

/** Counters an event must fit under; maintainers only meet the instance-wide safety caps. */
export function countersFor(match: Match, limits: RunLimits, day: string): { key: string; limit: number }[] {
  const counters = [
    { key: `runs:${day}`, limit: limits.runs_per_day },
    { key: `repo:${match.repo.toLowerCase()}:${day}`, limit: limits.runs_per_repo_per_day },
  ];
  if (!match.trusted) {
    counters.push({ key: `person:${match.sender.toLowerCase()}:${day}`, limit: limits.outsider_events_per_day });
    if (match.followUp) counters.push({ key: `pushes:${match.repo.toLowerCase()}#${match.number}:${day}`, limit: limits.outsider_pushes_per_pr_per_day });
  }
  return counters;
}

// A 👀 right away tells people tidy saw the event; the run swaps it for 🚀 or 😕 when it ends.
async function acknowledge(app: AppRecord, dispatch: Dispatch): Promise<number | undefined> {
  try {
    const token = await installationToken(app, dispatch.installationId, { issues: "write", pull_requests: "write" }, [dispatch.repoId]);
    const subject = dispatch.commentId
      ? `/repos/${dispatch.repo}/issues/comments/${dispatch.commentId}/reactions`
      : `/repos/${dispatch.repo}/issues/${dispatch.number}/reactions`;
    const reaction = await github<{ id: number }>(subject, { token: token.token, method: "POST", body: { content: "eyes" } });
    return reaction.id;
  } catch (error) {
    console.error("Could not add the reaction", error);
    return undefined;
  }
}

let tidyToken: { token: string; exp: number } | undefined;

/** A token for the tidy repository itself, to read tidy.yml and start workflows. */
async function tidyRepoToken(app: AppRecord, repo: { installationId: number; id: number }): Promise<string> {
  if (!tidyToken || tidyToken.exp - 300_000 < Date.now()) {
    const token = await installationToken(app, repo.installationId, { contents: "write" }, [repo.id]);
    tidyToken = { token: token.token, exp: Date.parse(token.expires_at) };
  }
  return tidyToken.token;
}

// Edits to tidy.yml take effect within this time, without a redeploy.
const LIMITS_CACHE_MS = 5 * 60_000;
let limitsCache: { at: number; limits: RunLimits } | undefined;

async function loadLimits(instance: Instance, repo: Required<Instance["repo"]>): Promise<RunLimits> {
  if (limitsCache && Date.now() - limitsCache.at < LIMITS_CACHE_MS) return limitsCache.limits;
  let limits = limitsCache?.limits ?? DEFAULT_LIMITS;
  try {
    const yaml = await github<string>(`/repos/${repo.fullName}/contents/tidy.yml?ref=${encodeURIComponent(repo.defaultBranch)}`, {
      token: await tidyRepoToken(instance.app, repo),
      accept: "application/vnd.github.raw",
    });
    limits = parseLimits(yaml);
  } catch (error) {
    console.error("Could not read limits from tidy.yml; keeping the last known ones", error);
  }
  limitsCache = { at: Date.now(), limits };
  return limits;
}

export async function handleWebhook(request: Request, env: Env, origin: string): Promise<Response> {
  const instance = await loadInstance(env);
  if (!instance) return new Response("not configured", { status: 503 });
  const body = await request.text();
  if (!(await signatureMatches(instance.app.webhookSecret, body, request.headers.get("x-hub-signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  const payload = JSON.parse(body) as Payload;
  const match = classify(event, payload, `${instance.app.slug}[bot]`, instance.repo.fullName);
  if (!match) return new Response("ignored", { status: 202 });

  const repo = await resolveRepo(env, instance);
  const limits = await loadLimits(instance, repo);
  const state = stateOf(env);
  const delivery = request.headers.get("x-github-delivery") ?? crypto.randomUUID();
  const admitted = await state.admit(delivery, countersFor(match, limits, new Date().toISOString().slice(0, 10)), 2 * 86_400_000);
  if (!admitted.ok) return new Response(`skipped: ${admitted.reason}`, { status: admitted.reason === "duplicate" ? 202 : 429 });

  const dispatchId = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const record: Dispatch = {
    kind: match.kind,
    repo: match.repo,
    repoId: match.repoId,
    number: match.number,
    installationId: payload.installation!.id,
    ...(match.commentId ? { commentId: match.commentId } : {}),
    ...(match.followUp ? { followUp: true } : {}),
    ...(match.requested ? { requested: true } : {}),
  };
  record.reaction = await acknowledge(instance.app, record);
  await state.put(`dispatch:${dispatchId}`, JSON.stringify(record), 86_400_000);

  await github(`/repos/${repo.fullName}/dispatches`, {
    token: await tidyRepoToken(instance.app, repo),
    method: "POST",
    body: {
      event_type: "tidy",
      client_payload: { dispatch_id: dispatchId, worker: origin, kind: record.kind, repo: record.repo, number: record.number },
    },
  });
  return new Response("dispatched", { status: 202 });
}
