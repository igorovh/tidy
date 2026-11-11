import type { TidyState } from "./state";

export interface Env {
  STATE: DurableObjectNamespace<TidyState>;
  TIDY_MASTER_KEY: string;
  /** Upper bound on workflow runs the Worker starts per UTC day. */
  DAILY_RUN_LIMIT?: string;
}

export interface AppRecord {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** PKCS#8 PEM body, base64 without armor. */
  privateKey: string;
  ownerId: number;
  ownerLogin: string;
}

export interface RepoRecord {
  fullName: string;
  id?: number;
  ownerId?: number;
  defaultBranch?: string;
  installationId?: number;
}

export interface Instance {
  app: AppRecord;
  repo: RepoRecord;
  /** Model credentials, keyed by the environment variable OpenCode reads. */
  keys: Record<string, { value: string; updated: string; by: string }>;
}

export interface Dispatch {
  kind: "issue" | "review" | "command";
  repo: string;
  repoId: number;
  installationId: number;
  number: number;
  commentId?: number;
}

export const stateOf = (env: Env) => env.STATE.get(env.STATE.idFromName("tidy"));
