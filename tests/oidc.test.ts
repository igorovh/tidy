import { beforeAll, describe, expect, test } from "bun:test";
import { b64url, utf8 } from "../shared/encoding";
import { type ActionsClaims, ISSUER, type Jwks, roleFor, verifyActionsToken } from "../worker/oidc";

const repo = { fullName: "alice/tidy", id: 42, ownerId: 7, defaultBranch: "main" };
let keys: CryptoKeyPair;
let jwks: Jwks;

const claims = (overrides: Partial<ActionsClaims> = {}): ActionsClaims => ({
  iss: ISSUER,
  aud: "tidy:abc",
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000) - 5,
  jti: crypto.randomUUID(),
  repository_id: "42",
  repository_owner_id: "7",
  ref: "refs/heads/main",
  event_name: "repository_dispatch",
  job_workflow_ref: "alice/tidy/.github/workflows/publish.yml@refs/heads/main",
  runner_environment: "github-hosted",
  run_id: "100",
  ...overrides,
});

async function sign(payload: object): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ alg: "RS256", kid: "k1" })));
  const body = b64url(utf8(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, utf8(`${header}.${body}`));
  return `${header}.${body}.${b64url(signature)}`;
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwks = { keys: [{ ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" }] };
});

describe("verifyActionsToken", () => {
  const fetchJwks = async () => jwks;

  test("accepts a token signed by the issuer for this audience", async () => {
    const result = await verifyActionsToken(await sign(claims()), "tidy:abc", fetchJwks);
    expect(result.run_id).toBe("100");
  });

  test("rejects a token minted for another key", async () => {
    await expect(verifyActionsToken(await sign(claims()), "tidy:other", fetchJwks)).rejects.toThrow("audience");
  });

  test("rejects expired tokens and other issuers", async () => {
    await expect(verifyActionsToken(await sign(claims({ exp: 1 })), "tidy:abc", fetchJwks)).rejects.toThrow("not valid");
    await expect(verifyActionsToken(await sign(claims({ iss: "https://evil" })), "tidy:abc", fetchJwks)).rejects.toThrow("issuer");
  });

  test("rejects a tampered payload", async () => {
    const token = await sign(claims());
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64url(utf8(JSON.stringify(claims({ repository_id: "1" }))))}.${s}`;
    await expect(verifyActionsToken(forged, "tidy:abc", fetchJwks)).rejects.toThrow("signature");
  });
});

describe("roleFor", () => {
  test("maps each credential-bearing workflow to its role", () => {
    const ref = (file: string) => `alice/tidy/.github/workflows/${file}@refs/heads/main`;
    expect(roleFor(claims({ job_workflow_ref: ref("publish.yml") }), repo)).toBe("write");
    expect(roleFor(claims({ job_workflow_ref: ref("agent.yml") }), repo)).toBe("agent");
    expect(roleFor(claims({ job_workflow_ref: ref("gate.yml") }), repo)).toBe("read");
  });

  test("the agent and checks workflows cannot pose as the publisher", () => {
    expect(() => roleFor(claims({ job_workflow_ref: "alice/tidy/.github/workflows/checks.yml@refs/heads/main" }), repo)).toThrow();
    expect(() => roleFor(claims({ job_workflow_ref: "alice/tidy/.github/workflows/tidy.yml@refs/heads/main" }), repo)).toThrow();
  });

  test("rejects tokens from branches, pull requests, other repositories and self-hosted runners", () => {
    expect(() => roleFor(claims({ ref: "refs/heads/feature" }), repo)).toThrow("default branch");
    expect(() => roleFor(claims({ job_workflow_ref: "alice/tidy/.github/workflows/publish.yml@refs/heads/feature" }), repo)).toThrow();
    expect(() => roleFor(claims({ event_name: "pull_request" }), repo)).toThrow("dispatch");
    expect(() => roleFor(claims({ repository_id: "43" }), repo)).toThrow("tidy repository");
    expect(() => roleFor(claims({ runner_environment: "self-hosted" }), repo)).toThrow("GitHub-hosted");
  });

  test("a reusable workflow from a similarly named repository is rejected", () => {
    const ref = "alice/tidy-fork/.github/workflows/publish.yml@refs/heads/main";
    expect(() => roleFor(claims({ job_workflow_ref: ref }), repo)).toThrow("Unexpected workflow");
  });
});
