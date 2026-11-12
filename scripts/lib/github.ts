export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function client(token: string) {
  async function request<T>(path: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<T> {
    let response: Response;
    // GitHub answers with a passing 5xx now and then. Reads and git objects are safe to send twice;
    // a retried comment could post twice, so those are not retried.
    const retries = (init.method ?? "GET") === "GET" || path.includes("/git/") ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      response = await fetch(`https://api.github.com${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: init.accept ?? "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "tidy-bot",
          "x-github-api-version": "2022-11-28",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (response.status < 500 || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new GitHubError(response.status, `GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    return (init.accept?.includes("json") === false ? await response.text() : await response.json()) as T;
  }

  async function paginate<T>(path: string, limit = 500): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; items.length < limit; page++) {
      const batch = await request<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items.slice(0, limit);
  }

  return { request, paginate };
}

export type GitHubClient = ReturnType<typeof client>;

const WRITERS = new Set(["admin", "maintain", "write"]);

export async function canWrite(gh: GitHubClient, repo: string, login: string): Promise<boolean> {
  try {
    const result = await gh.request<{ permission: string }>(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
    return WRITERS.has(result.permission);
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 404 || error.status === 403)) return false;
    throw error;
  }
}
