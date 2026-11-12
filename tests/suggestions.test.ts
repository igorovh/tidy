import { describe, expect, test } from "bun:test";
import { expiredFolders } from "../scripts/lib/assets";
import { validateReview, withSuggestion } from "../scripts/lib/review";

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "+two",
  "+three",
  " four",
  "@@ -20,2 +21,2 @@",
  " twenty-one",
  "+twenty-two",
].join("\n");

const review = (comment: object) => validateReview({ summary: "x", comments: [comment] }, diff);

describe("suggestions", () => {
  test("a suggestion inside the diff is kept for one-click commit", () => {
    const [comment] = review({ path: "src/a.ts", line: 3, start_line: 2, body: "Use one line.", suggestion: "two_and_three" }).comments;
    expect(comment).toEqual({ path: "src/a.ts", line: 3, start_line: 2, body: "Use one line.", suggestion: "two_and_three" });
  });

  test("a range that spans two parts of the diff loses its suggestion but keeps the comment", () => {
    const [comment] = review({ path: "src/a.ts", line: 22, start_line: 3, body: "Too far.", suggestion: "x" }).comments;
    expect(comment).toEqual({ path: "src/a.ts", line: 22, body: "Too far." });
  });

  test("code with backticks cannot close the suggestion block early", () => {
    const block = withSuggestion("Fix:", "const s = ```nested```;");
    expect(block).toStartWith("Fix:\n\n````suggestion\n");
    expect(block).toEndWith("\n````");
  });

  test("the comment text is still cleaned while the suggestion code is left alone", () => {
    const [comment] = review({ path: "src/a.ts", line: 2, body: "<img src=//evil.test/x> ping @octocat", suggestion: "if (a < b) {}" }).comments;
    expect(comment!.body).not.toContain("evil.test");
    expect(comment!.suggestion).toBe("if (a < b) {}");
  });
});

describe("tidy-assets branch", () => {
  test("only date folders older than 30 days and stray folders are dropped", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    expect(expiredFolders(["2026-11-12", "2026-10-14", "2026-10-12", "notes"], now)).toEqual(["2026-10-12", "notes"]);
  });
});
