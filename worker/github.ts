import { b64, b64url, fromB64, utf8 } from "../shared/encoding";
import type { AppRecord } from "./env";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// GitHub hands out PKCS#1 keys, but WebCrypto only imports PKCS#8.
export function pkcs1ToPkcs8(pem: string): string {
  const match = pem.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/);
  if (!match) throw new Error("Not a PEM private key");
  const body = match[2]!.replace(/\s+/g, "");
  if (!match[1]) return body;
  const pkcs1 = fromB64(body);
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const inner = [0x02, 0x01, 0x00, ...algorithm, 0x04, ...derLength(pkcs1.length), ...pkcs1];
  return b64(new Uint8Array([0x30, ...derLength(inner.length), ...inner]));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function signingKey(pkcs8: string): Promise<CryptoKey> {
  let key = keyCache.get(pkcs8);
  if (!key) {
    key = crypto.subtle.importKey("pkcs8", fromB64(pkcs8), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(pkcs8, key);
  }
  return key;
}

let jwtCache: { appId: number; jwt: string; exp: number } | undefined;

export async function appJwt(app: Pick<AppRecord, "id" | "privateKey">): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache?.appId === app.id && jwtCache.exp - 60 > now) return jwtCache.jwt;
  const header = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const exp = now + 540;
  const payload = b64url(utf8(JSON.stringify({ iat: now - 60, exp, iss: app.id })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(app.privateKey), utf8(`${header}.${payload}`));
  const jwt = `${header}.${payload}.${b64url(signature)}`;
  jwtCache = { appId: app.id, jwt, exp };
  return jwt;
}

export async function github<T>(
  path: string,
  options: { app?: AppRecord; token?: string; method?: string; body?: unknown; accept?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: options.accept ?? "application/vnd.github+json",
    "user-agent": "tidy-bot",
    "x-github-api-version": "2022-11-28",
  };
  if (options.app) headers.authorization = `Bearer ${await appJwt(options.app)}`;
  else if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw new GitHubError(response.status, `GitHub ${options.method ?? "GET"} ${path}: ${response.status}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export type Permissions = Partial<Record<"contents" | "issues" | "pull_requests" | "metadata", "read" | "write">>;

export async function installationToken(
  app: AppRecord,
  installationId: number,
  permissions: Permissions,
  repositoryIds?: number[],
): Promise<{ token: string; expires_at: string }> {
  return github(`/app/installations/${installationId}/access_tokens`, {
    app,
    method: "POST",
    body: { permissions, ...(repositoryIds ? { repository_ids: repositoryIds } : {}) },
  });
}
