import { describe, expect, test } from "bun:test";
import { withoutCode } from "../scripts/lib/sanitize";
import { PENDING, secretWorkflows } from "../scripts/lib/workflows";

describe("secretWorkflows", () => {
  const check = (text: string) => secretWorkflows([{ path: "w.yml", text }]);
  const secret = "jobs:\n  r:\n    env:\n      K: ${{ secrets.NPM_TOKEN }}\n";

  test("ordinary CI without secrets lets tidy open pull requests right away", () => {
    expect(check("on: [push, pull_request]\njobs:\n  t:\n    steps:\n      - run: bun test\n")).toEqual([]);
    expect(check("on:\n  pull_request:\njobs:\n  t:\n    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n")).toEqual([]);
  });

  test("pull request workflows that read secrets need approval", () => {
    expect(check("on:\n  pull_request:\njobs:\n  d:\n    env:\n      KEY: ${{ secrets.DEPLOY_KEY }}\n")).toEqual(["w.yml"]);
    expect(check("on: pull_request_target\njobs:\n  d:\n    uses: o/r/.github/workflows/x.yml@main\n    secrets: inherit\n")).toEqual(["w.yml"]);
    expect(check("on:\n  workflow_run:\n    workflows: [CI]\njobs:\n  d:\n    env:\n      K: ${{ secrets['NPM'] }}\n")).toEqual(["w.yml"]);
  });

  test("push workflows that would run on tidy's branches need approval too", () => {
    expect(check(`on: [push]\n${secret}`)).toEqual(["w.yml"]);
    expect(check(`on:\n  push:\n${secret}`)).toEqual(["w.yml"]);
    expect(check(`on:\n  push:\n    branches: ["**"]\n${secret}`)).toEqual(["w.yml"]);
    expect(check(`on:\n  push:\n    branches: ["tidy/**"]\n${secret}`)).toEqual(["w.yml"]);
    expect(check(`on:\n  push:\n    branches-ignore: [main]\n${secret}`)).toEqual(["w.yml"]);
  });

  test("push workflows limited to other branches or tags do not block", () => {
    expect(check(`on:\n  push:\n    branches: [main]\n${secret}`)).toEqual([]);
    expect(check(`on:\n  push:\n    branches: ["*"]\n${secret}`)).toEqual([]);
    expect(check(`on:\n  push:\n    branches: ["**", "!tidy/**"]\n${secret}`)).toEqual([]);
    expect(check(`on:\n  push:\n    branches-ignore: ["tidy/**"]\n${secret}`)).toEqual([]);
    expect(check(`on:\n  push:\n    tags: ["v*"]\n${secret}`)).toEqual([]);
  });

  test("cloud credentials through OIDC count like a secret", () => {
    expect(check("on: [pull_request]\npermissions:\n  id-token: write\njobs:\n  d:\n    steps:\n      - run: deploy\n")).toEqual(["w.yml"]);
  });

  test("a file that cannot be parsed counts as risky", () => {
    expect(check("on: [pull_request\nsecrets.X: {")).toEqual(["w.yml"]);
  });
});

describe("approval marker", () => {
  test("only the last marker in tidy's comment counts", () => {
    const fake = `<!-- tidy:pending run=1 sha=${"a".repeat(64)} -->`;
    const real = `<!-- tidy:pending run=2 sha=${"b".repeat(64)} -->`;
    const matches = [...withoutCode(`\`\`\`diff\n+${fake}\n\`\`\`\n${real}`).matchAll(new RegExp(PENDING.source, "g"))];
    expect(matches.pop()?.[1]).toBe("2");
  });

  test("a marker quoted in code is not a proposal", () => {
    const marker = `<!-- tidy:pending run=1 sha=${"a".repeat(64)} -->`;
    expect(PENDING.test(withoutCode(`I could not fix this: \`${marker}\``))).toBe(false);
    expect(PENDING.test(withoutCode(`\`\`\`\n${marker}\n\`\`\``))).toBe(false);
  });
});
