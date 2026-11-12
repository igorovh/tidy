import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "../scripts/lib/github";
import { statusComment } from "../scripts/lib/status";

const bot = "tidy[bot]";
const target = { kind: "review" as const, repo: "a/b", number: 4 };

// A tiny in-memory issue thread that answers the calls statusComment makes.
function thread() {
  let next = 1;
  const comments: { id: number; body: string; user: { login: string } }[] = [{ id: next++, body: "LGTM", user: { login: "alice" } }];
  const gh = {
    paginate: async () => structuredClone(comments),
    request: async (path: string, init: { method?: string; body?: { body: string } } = {}) => {
      const id = Number(path.split("/").pop());
      if (init.method === "POST") comments.push({ id: next++, body: init.body!.body, user: { login: bot } });
      if (init.method === "PATCH") comments.find((c) => c.id === id)!.body = init.body!.body;
      if (init.method === "DELETE") comments.splice(comments.findIndex((c) => c.id === id), 1);
    },
  } as unknown as GitHubClient;
  return { gh, comments };
}

describe("status comment", () => {
  test("a run posts one note and edits it into its result", async () => {
    const { gh, comments } = thread();
    const status = statusComment(gh, target, bot, "100");
    await status.start("reviewing");
    expect(await status.finish("Reviewed commit `abc1234`")).toBe(true);
    expect(comments.filter((c) => c.user.login === bot).map((c) => c.body)).toEqual(["Reviewed commit `abc1234`\n<!-- tidy:status run=100 -->"]);
  });

  test("the next run reuses the same note instead of adding one", async () => {
    const { gh, comments } = thread();
    await statusComment(gh, target, bot, "100").start("reviewing");
    await statusComment(gh, target, bot, "101").start("reviewing again");
    expect(comments.filter((c) => c.user.login === bot)).toHaveLength(1);
  });

  test("a cancelled run cannot finish or delete a newer run's note", async () => {
    const { gh, comments } = thread();
    const old = statusComment(gh, target, bot, "100");
    await old.start("reviewing");
    await statusComment(gh, target, bot, "101").start("reviewing the new push");
    expect(await old.finish("stale result")).toBe(false);
    await old.remove();
    expect(comments.find((c) => c.user.login === bot)?.body).toContain("reviewing the new push");
  });

  test("without a note there is nothing to edit, so the caller posts its own comment", async () => {
    const { gh } = thread();
    expect(await statusComment(gh, target, bot, "100").finish("result")).toBe(false);
  });
});
