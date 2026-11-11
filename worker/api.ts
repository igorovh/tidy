import { isAdmin } from "./admin";
import { type Env, stateOf } from "./env";
import { github, GitHubError, installationToken } from "./github";
import { loadInstance } from "./instance";

const deny = (message: string, status: number) => Response.json({ error: message }, { status });

/**
 * Lists repositories the App is installed on, for `bun run protect`. The caller proves who they are
 * with their own GitHub token, which is only used for that check and never stored.
 */
export async function handleRepos(request: Request, env: Env): Promise<Response> {
  const instance = await loadInstance(env);
  if (!instance) return deny("not configured", 503);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await stateOf(env).take(`api:${ip}:${new Date().toISOString().slice(0, 13)}`, 30, 7_200_000))) {
    return deny("too many requests", 429);
  }
  const token = request.headers.get("authorization")?.match(/^Bearer (\S{20,255})$/)?.[1];
  if (!token) return deny("missing token", 401);
  let login: string;
  try {
    login = (await github<{ login: string }>("/user", { token })).login;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) return deny("invalid token", 401);
    throw error;
  }
  if (!(await isAdmin(env, instance, login))) return deny("not an admin of the tidy repository", 403);

  const installations = await github<{ id: number }[]>("/app/installations?per_page=100", { app: instance.app });
  const repos: string[] = [];
  for (const installation of installations.slice(0, 10)) {
    const access = await installationToken(instance.app, installation.id, { metadata: "read" });
    for (let page = 1; page <= 5; page++) {
      const batch = await github<{ repositories: { full_name: string }[] }>(`/installation/repositories?per_page=100&page=${page}`, {
        token: access.token,
      });
      repos.push(...batch.repositories.map((r) => r.full_name));
      if (batch.repositories.length < 100) break;
    }
  }
  return Response.json({ repos });
}
