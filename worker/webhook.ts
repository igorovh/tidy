import { b64url, timingSafeEqual, utf8 } from "../shared/encoding";
import type { Dispatch, Env } from "./env";
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
  repository?: { id: number; full_name: string };
  sender?: { login: string; type: string };
  issue?: { number: number; pull_request?: unknown; state: string };
  comment?: { id: number; body: string; user: { type: string } };
  pull_request?: { number: number; draft: boolean };
}

/** Decides from the event alone whether a run is worth starting; everything else happens in Actions. */
export function classify(event: string, payload: Payload, botLogin: string, tidyRepo: string): Omit<Dispatch, "installationId"> | null {
  const repo = payload.repository;
  if (!repo || !payload.installation || !payload.sender) return null;
  if (repo.full_name.toLowerCase() === tidyRepo.toLowerCase()) return null;
  const ours = payload.sender.login === botLogin;
  const base = { repo: repo.full_name, repoId: repo.id };
  if (event === "issues" && payload.action === "opened" && payload.issue && payload.sender.type !== "Bot") {
    return { ...base, kind: "issue", number: payload.issue.number };
  }
  if (event === "issue_comment" && payload.action === "created" && payload.issue && payload.comment) {
    if (payload.sender.type === "Bot" || payload.comment.user.type === "Bot") return null;
    if (!new RegExp(`^\\s*@(tidy|${botLogin.replace(/\[bot\]$/, "")})\\b`, "i").test(payload.comment.body)) return null;
    return { ...base, kind: "command", number: payload.issue.number, commentId: payload.comment.id };
  }
  if (event === "pull_request" && payload.pull_request && !payload.pull_request.draft) {
    if (!["opened", "reopened", "ready_for_review"].includes(payload.action ?? "")) return null;
    // Other bots (Renovate, Dependabot) are skipped; tidy's own PRs still get a review.
    if (payload.sender.type === "Bot" && !ours) return null;
    return { ...base, kind: "review", number: payload.pull_request.number };
  }
  return null;
}

let dispatchToken: { token: string; exp: number } | undefined;

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

  const state = stateOf(env);
  const delivery = request.headers.get("x-github-delivery") ?? crypto.randomUUID();
  const nonce = crypto.randomUUID();
  if ((await state.claim(`delivery:${delivery}`, nonce, 86_400_000)) !== nonce) {
    return new Response("duplicate", { status: 202 });
  }
  const repo = await resolveRepo(env, instance);
  const day = new Date().toISOString().slice(0, 10);
  if (!(await state.take(`runs:${day}`, Number(env.DAILY_RUN_LIMIT ?? 60), 2 * 86_400_000))) {
    return new Response("daily run limit reached", { status: 429 });
  }
  const dispatchId = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const record: Dispatch = { ...match, installationId: payload.installation!.id };
  await state.put(`dispatch:${dispatchId}`, JSON.stringify(record), 86_400_000);

  if (!dispatchToken || dispatchToken.exp - 300_000 < Date.now()) {
    const token = await installationToken(instance.app, repo.installationId, { contents: "write" }, [repo.id]);
    dispatchToken = { token: token.token, exp: Date.parse(token.expires_at) };
  }
  await github(`/repos/${repo.fullName}/dispatches`, {
    token: dispatchToken.token,
    method: "POST",
    body: {
      event_type: "tidy",
      client_payload: { dispatch_id: dispatchId, worker: origin, kind: record.kind, repo: record.repo, number: record.number },
    },
  });
  return new Response("dispatched", { status: 202 });
}
