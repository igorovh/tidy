import { fromB64url, fromUtf8, utf8 } from "../shared/encoding";

export const ISSUER = "https://token.actions.githubusercontent.com";

export interface ActionsClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat: number;
  jti: string;
  repository_id: string;
  repository_owner_id: string;
  ref: string;
  event_name: string;
  job_workflow_ref: string;
  runner_environment: string;
  run_id: string;
}

export type Jwks = { keys: (JsonWebKey & { kid: string })[] };

let jwksCache: { at: number; jwks: Jwks } | undefined;

async function fetchJwks(force: boolean): Promise<Jwks> {
  if (!force && jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.jwks;
  const response = await fetch(`${ISSUER}/.well-known/jwks`);
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
  jwksCache = { at: Date.now(), jwks: await response.json() };
  return jwksCache.jwks;
}

/** Verifies the signature and standard claims; caller checks the workflow-specific ones. */
export async function verifyActionsToken(
  token: string,
  audience: string,
  getJwks: (force: boolean) => Promise<Jwks> = fetchJwks,
): Promise<ActionsClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed OIDC token");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(fromUtf8(fromB64url(h))) as { alg: string; kid: string };
  if (header.alg !== "RS256") throw new Error("Unexpected OIDC algorithm");
  let jwk = (await getJwks(false)).keys.find((key) => key.kid === header.kid);
  jwk ??= (await getJwks(true)).keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("Unknown OIDC signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), utf8(`${h}.${p}`)))) {
    throw new Error("Invalid OIDC signature");
  }
  const claims = JSON.parse(fromUtf8(fromB64url(p))) as ActionsClaims;
  const now = Date.now() / 1000;
  if (claims.iss !== ISSUER) throw new Error("Unexpected OIDC issuer");
  if ((Array.isArray(claims.aud) ? claims.aud : [claims.aud]).join() !== audience) throw new Error("Unexpected OIDC audience");
  if (claims.exp < now || (claims.nbf ?? claims.iat) > now + 60) throw new Error("OIDC token is not valid now");
  return claims;
}

export type Role = "read" | "agent" | "write";

// Only these reusable workflows may ask for credentials; the claim is set by GitHub, not the job.
const ROLES: Record<string, Role> = {
  "gate.yml": "read",
  "agent.yml": "agent",
  "publish.yml": "write",
};

export function roleFor(
  claims: ActionsClaims,
  repo: { fullName: string; id: number; ownerId: number; defaultBranch: string },
): Role {
  const ref = `refs/heads/${repo.defaultBranch}`;
  if (claims.repository_id !== String(repo.id) || claims.repository_owner_id !== String(repo.ownerId)) {
    throw new Error("Token is not from the tidy repository");
  }
  if (claims.ref !== ref) throw new Error("Token is not from the default branch");
  if (claims.event_name !== "repository_dispatch") throw new Error("Token is not from a tidy dispatch");
  if (claims.runner_environment !== "github-hosted") throw new Error("Token is not from a GitHub-hosted runner");
  const prefix = `${repo.fullName}/.github/workflows/`.toLowerCase();
  const workflow = claims.job_workflow_ref.toLowerCase();
  if (!workflow.startsWith(prefix) || !workflow.endsWith(`@${ref}`.toLowerCase())) throw new Error("Unexpected workflow");
  const role = ROLES[workflow.slice(prefix.length, -`@${ref}`.length)];
  if (!role) throw new Error("This workflow may not request credentials");
  return role;
}
