import type { Target } from "./credentials";
import type { GitHubClient } from "./github";

const STATUS = /<!-- tidy:status run=\d+ -->/;

/**
 * One comment per thread that says what tidy is doing. A run claims it when it starts and edits it when it
 * ends, so new commits on a pull request reuse it instead of adding a comment each time. A run only
 * finishes the comment while it still carries its own marker, so a cancelled run cannot overwrite a newer one.
 */
export function statusComment(gh: GitHubClient, target: Target, bot: string, runId: string) {
  const marker = `<!-- tidy:status run=${runId} -->`;
  const comments = `/repos/${target.repo}/issues/${target.number}/comments`;
  const latest = async () =>
    (await gh.paginate<{ id: number; body: string; user: { login: string } | null }>(comments, 300))
      .filter((c) => c.user?.login === bot && STATUS.test(c.body))
      .pop();
  const write = (id: number | undefined, text: string) =>
    id
      ? gh.request(`/repos/${target.repo}/issues/comments/${id}`, { method: "PATCH", body: { body: `${text}\n${marker}` } })
      : gh.request(comments, { method: "POST", body: { body: `${text}\n${marker}` } });

  return {
    async start(text: string): Promise<void> {
      await write((await latest())?.id, text);
    },
    /** Replaces this run's status with the result; false when there is none, so the caller posts instead. */
    async finish(text: string): Promise<boolean> {
      const current = await latest();
      if (!current?.body.includes(marker)) return false;
      await write(current.id, text);
      return true;
    },
    async remove(): Promise<void> {
      const current = await latest();
      if (current?.body.includes(marker)) await gh.request(`/repos/${target.repo}/issues/comments/${current.id}`, { method: "DELETE" });
    },
  };
}

export type StatusComment = ReturnType<typeof statusComment>;
