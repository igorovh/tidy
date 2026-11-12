import { decrypt, deriveKeys, encrypt } from "./crypto";
import { type Env, type Instance, stateOf } from "./env";
import { github, installationToken } from "./github";

// Saves a Durable Object call per request; a key change made in another isolate shows up within a minute.
const CACHE_MS = 60_000;
let cache: { at: number; value: Instance } | undefined;

export async function loadInstance(env: Env): Promise<Instance | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const raw = await stateOf(env).get("instance");
  if (!raw) return null;
  const value = JSON.parse(await decrypt(await deriveKeys(env.TIDY_MASTER_KEY), "instance", raw)) as Instance;
  cache = { at: Date.now(), value };
  return value;
}

export async function saveInstance(env: Env, instance: Instance): Promise<void> {
  const raw = await encrypt(await deriveKeys(env.TIDY_MASTER_KEY), "instance", JSON.stringify(instance));
  await stateOf(env).put("instance", raw);
  cache = { at: Date.now(), value: instance };
}

/** Resolves the tidy repository's IDs once the App is installed on it. */
export async function resolveRepo(env: Env, instance: Instance): Promise<Required<Instance["repo"]>> {
  const repo = instance.repo;
  if (repo.id && repo.ownerId && repo.defaultBranch && repo.installationId) return repo as Required<Instance["repo"]>;
  const installation = await github<{ id: number }>(`/repos/${repo.fullName}/installation`, { app: instance.app });
  const token = await installationToken(instance.app, installation.id, { metadata: "read" });
  const data = await github<{ id: number; owner: { id: number }; default_branch: string }>(`/repos/${repo.fullName}`, {
    token: token.token,
  });
  instance.repo = {
    fullName: repo.fullName,
    id: data.id,
    ownerId: data.owner.id,
    defaultBranch: data.default_branch,
    installationId: installation.id,
  };
  await saveInstance(env, instance);
  return instance.repo as Required<Instance["repo"]>;
}
