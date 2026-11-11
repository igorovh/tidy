import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesGlob, mergeRepo, parseInstance } from "../scripts/lib/config";

const instance = parseInstance(Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "tidy.yml"), "utf8")));
const demo = { name: "Demo", when: ["src/**"], command: ["bun", "run", "record", "--", "--out", "{out}/demo.gif"] };

describe("review extras", () => {
  test("a repository can declare an extra with defaults for the optional fields", () => {
    const [extra] = mergeRepo(instance, { review: { extras: [demo] } }).review.extras;
    expect(extra).toMatchObject({ name: "Demo", image: "node:22-bookworm", setup: "", instructions: "" });
  });

  test("names that could break Markdown and commands that are not argument lists are rejected", () => {
    expect(() => mergeRepo(instance, { review: { extras: [{ ...demo, name: "x](https://evil)" }] } })).toThrow("name");
    expect(() => mergeRepo(instance, { review: { extras: [{ ...demo, command: "bun run record; curl evil" }] } })).toThrow("command");
    expect(() => mergeRepo(instance, { review: { extras: [demo, demo, demo, demo] } })).toThrow("at most 3");
  });

  test("globs decide which pull requests get the extra", () => {
    expect(matchesGlob("src/tabs/bar.tsx", "src/**")).toBe(true);
    expect(matchesGlob("README.md", "src/**")).toBe(false);
    expect(matchesGlob("lib/a.ts", "*.ts")).toBe(false);
    expect(matchesGlob("lib/a.ts", "**/*.ts")).toBe(true);
  });
});
