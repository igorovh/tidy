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

  const redeemed = await stateOf(env).redeem({
    jti: claims.jti,
    publicKey: input.public_key,
    dispatchId: input.dispatch_id,
    runId: claims.run_id,
    ...(role === "write" ? { writeLimit: WRITE_TOKENS_PER_RUN } : {}),
  });
  if ("error" in redeemed) return deny(redeemed.error);
  const dispatch = JSON.parse(redeemed.dispatch) as Dispatch;

  const target = { kind: dispatch.kind, repo: dispatch.repo, number: dispatch.number, comment_id: dispatch.commentId, reaction: dispatch.reaction, follow_up: dispatch.followUp };
  let credentials: Record<string, unknown>;
  if (role === "agent") {
    credentials = { keys: Object.fromEntries(Object.entries(instance.keys).map(([name, key]) => [name, key.value])) };
  } else {
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
  // The admin is pinged when the model provider refuses tidy's key, for example when usage runs out.
  const body = JSON.stringify({ role, target, bot: { login: `${instance.app.slug}[bot]` }, admin: instance.app.ownerLogin, ...credentials });
  return Response.json(await seal(input.public_key, body, `${input.dispatch_id}|${claims.run_id}|${role}`));
}
