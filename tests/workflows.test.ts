import { describe, expect, test } from "bun:test";
import { PENDING, secretWorkflows } from "../scripts/lib/workflows";

describe("secretWorkflows", () => {
  const check = (text: string) => secretWorkflows([{ path: "w.yml", text }]);

  test("ordinary CI without secrets lets tidy open pull requests right away", () => {
    expect(check("on: [push, pull_request]\njobs:\n  t:\n    steps:\n      - run: bun test\n")).toEqual([]);
    expect(check("on:\n  pull_request:\njobs:\n  t:\n    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n")).toEqual([]);
  });

  test("pull request workflows that read secrets need approval", () => {
    expect(check("on:\n  pull_request:\njobs:\n  d:\n    env:\n      KEY: ${{ secrets.DEPLOY_KEY }}\n")).toEqual(["w.yml"]);
    expect(check("on: pull_request_target\njobs:\n  d:\n    uses: o/r/.github/workflows/x.yml@main\n    secrets: inherit\n")).toEqual(["w.yml"]);
    expect(check("on:\n  workflow_run:\n    workflows: [CI]\njobs:\n  d:\n    env:\n      K: ${{ secrets['NPM'] }}\n")).toEqual(["w.yml"]);
  });

  test("secrets used only on push or release do not block", () => {
    expect(check("on:\n  push:\n    branches: [main]\njobs:\n  r:\n    env:\n      K: ${{ secrets.NPM_TOKEN }}\n")).toEqual([]);
  });

  test("a file that cannot be parsed counts as risky", () => {
    expect(check("on: [pull_request\nsecrets.X: {")).toEqual(["w.yml"]);
  });
});

describe("approval marker", () => {
  test("only the last marker in tidy's comment counts", () => {
    const fake = `<!-- tidy:pending run=1 sha=${"a".repeat(64)} -->`;
    const real = `<!-- tidy:pending run=2 sha=${"b".repeat(64)} -->`;
    const matches = [...`\`\`\`diff\n+${fake}\n\`\`\`\n${real}`.matchAll(new RegExp(PENDING.source, "g"))];
    expect(matches.pop()?.[1]).toBe("2");
  });
});
