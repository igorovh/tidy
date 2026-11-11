import { audienceFor, seal } from "../shared/seal";
import { type Dispatch, type Env, stateOf } from "./env";
import { installationToken } from "./github";
import { loadInstance, resolveRepo } from "./instance";
import { roleFor, verifyActionsToken } from "./oidc";

const WRITE_TOKENS_PER_RUN = 4;

const deny = (message: string, status = 403) => Response.json({ error: message }, { status });

export async function handleToken(request: Request, env: Env): Promise<Response> {
  const instance = await loadInstance(env);
  if (!instance) return deny("not configured", 503);
  const input = (await request.json().catch(() => null)) as { oidc?: string; dispatch_id?: string; public_key?: string } | null;
  if (!input?.oidc || !input.dispatch_id || !input.public_key) return deny("missing fields", 400);

  const repo = await resolveRepo(env, instance);
  let role;
  let claims;
  try {
    claims = await verifyActionsToken(input.oidc, await audienceFor(input.public_key));
    role = roleFor(claims, repo);
  } catch (error) {
    return deny((error as Error).message);
  }

  const state = stateOf(env);
  if ((await state.claim(`jti:${claims.jti}`, input.public_key, 900_000)) !== input.public_key) return deny("token already used");
  const raw = await state.get(`dispatch:${input.dispatch_id}`);
  if (!raw) return deny("unknown dispatch");
  // The first run that redeems a dispatch owns it; another run cannot borrow its target.
  if ((await state.claim(`run:${input.dispatch_id}`, claims.run_id, 86_400_000)) !== claims.run_id) {
    return deny("dispatch belongs to another run");
  }
  const dispatch = JSON.parse(raw) as Dispatch;

  const target = { kind: dispatch.kind, repo: dispatch.repo, number: dispatch.number, comment_id: dispatch.commentId, reaction: dispatch.reaction, follow_up: dispatch.followUp };
  let credentials: Record<string, unknown>;
  if (role === "agent") {
    credentials = { keys: Object.fromEntries(Object.entries(instance.keys).map(([name, key]) => [name, key.value])) };
  } else {
    if (role === "write" && !(await state.take(`write:${claims.run_id}`, WRITE_TOKENS_PER_RUN, 86_400_000))) {
      return deny("write token limit reached for this run");
    }
    const token = await installationToken(
      instance.app,
      dispatch.installationId,
      role === "write"
        ? { contents: "write", pull_requests: "write", issues: "write", metadata: "read" }
        : { contents: "read", pull_requests: "read", issues: "read", metadata: "read" },
      [dispatch.repoId],
    );
    credentials = { token: token.token };
  }
  const body = JSON.stringify({ role, target, bot: { login: `${instance.app.slug}[bot]` }, ...credentials });
  return Response.json(await seal(input.public_key, body, `${input.dispatch_id}|${claims.run_id}|${role}`));
}
