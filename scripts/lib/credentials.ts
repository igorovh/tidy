import { audienceFor, createRecipient, open, type Sealed } from "../../shared/seal";
import { clientPayload, env, mask } from "./actions";

export interface Target {
  kind: "issue" | "review" | "command";
  repo: string;
  number: number;
  comment_id?: number;
  /** The 👀 reaction the Worker added when the event arrived. */
  reaction?: number;
  follow_up?: boolean;
}

export interface Credentials {
  role: "read" | "agent" | "write";
  target: Target;
  bot: { login: string };
  /** The tidy instance's owner, pinged when the model provider refuses tidy's key. */
  admin?: string;
  token?: string;
  keys?: Record<string, string>;
}

/** Trades this job's OIDC token for credentials sealed to a key that never leaves this process. */
export async function requestCredentials(expected: Credentials["role"]): Promise<Credentials> {
  const payload = clientPayload();
  const recipient = await createRecipient();
  const audience = await audienceFor(recipient.publicKey);
  const oidcUrl = new URL(env("ACTIONS_ID_TOKEN_REQUEST_URL"));
  oidcUrl.searchParams.set("audience", audience);
  const oidc = await fetch(oidcUrl, { headers: { authorization: `bearer ${env("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` } });
  if (!oidc.ok) throw new Error(`OIDC request failed: ${oidc.status}`);
  const { value } = (await oidc.json()) as { value: string };

  const response = await fetch(`${payload.worker}/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "tidy-bot" },
    body: JSON.stringify({ oidc: value, dispatch_id: payload.dispatch_id, public_key: recipient.publicKey }),
  });
  if (!response.ok) throw new Error(`tidy Worker refused credentials: ${response.status} ${await response.text()}`);
  const plain = await open(recipient, (await response.json()) as Sealed, `${payload.dispatch_id}|${env("GITHUB_RUN_ID")}|${expected}`);
  const credentials = JSON.parse(plain) as Credentials;
  if (credentials.role !== expected) throw new Error(`Expected ${expected} credentials, got ${credentials.role}`);
  if (credentials.token) mask(credentials.token);
  for (const key of Object.values(credentials.keys ?? {})) mask(key);
  return credentials;
}
