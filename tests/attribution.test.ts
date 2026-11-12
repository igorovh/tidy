import { describe, expect, test } from "bun:test";
import { commitMessage, thanks } from "../scripts/lib/attribution";

const author = { login: "octocat", id: 583231 };

describe("crediting the issue author", () => {
  test("a bug fix credits the reporter without making them a co-author", () => {
    const message = commitMessage("fix: keep tab order", 33, author, "bug");
    expect(message).toBe("fix: keep tab order\n\nCloses #33\n\nReported-by: octocat <583231+octocat@users.noreply.github.com>");
    expect(message).not.toContain("Co-authored-by");
  });

  test("features, docs and unknown kinds credit the suggestion", () => {
    expect(commitMessage("feat: x", 1, author, "feature")).toContain("Suggested-by: octocat");
    expect(commitMessage("docs: x", 1, author, "")).toContain("Suggested-by: octocat");
  });

  test("the pull request thanks the author for what they did", () => {
    expect(thanks(33, author, "bug")).toBe("Thanks @octocat for reporting this in #33.");
    expect(thanks(33, author, "feature")).toBe("Thanks @octocat for suggesting this in #33.");
  });
});
