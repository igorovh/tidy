import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { b64url, utf8 } from "../shared/encoding";
import { decrypt, deriveKeys, encrypt, signValue, verifyValue } from "../worker/crypto";
import { appJwt, pkcs1ToPkcs8 } from "../worker/github";
import { isSameOrigin } from "../worker/html";
import { classify, countersFor, signatureMatches } from "../worker/webhook";

const master = b64url(crypto.getRandomValues(new Uint8Array(32)));

describe("storage encryption", () => {
  test("a record cannot be decrypted under another name", async () => {
    const keys = await deriveKeys(master);
    const stored = await encrypt(keys, "instance", '{"secret":1}');
    expect(await decrypt(keys, "instance", stored)).toBe('{"secret":1}');
    await expect(decrypt(keys, "other", stored)).rejects.toThrow();
  });

  test("signed values reject tampering, the wrong purpose and expiry", async () => {
    const keys = await deriveKeys(master);
    const token = await signValue(keys, "session", { uid: 1 }, 60);
    expect(await verifyValue<{ uid: number }>(keys, "session", token)).toMatchObject({ uid: 1 });
    expect(await verifyValue(keys, "oauth", token)).toBeNull();
    const [, sig] = token.split(".");
    expect(await verifyValue(keys, "session", `${b64url(utf8(JSON.stringify({ uid: 2, exp: 9e9 })))}.${sig}`)).toBeNull();
    expect(await verifyValue(keys, "session", await signValue(keys, "session", { uid: 1 }, -1))).toBeNull();
  });
});

describe("GitHub App key", () => {
  test("the PKCS#1 key GitHub returns signs a JWT that verifies with the public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = await appJwt({ id: 123, privateKey: pkcs1ToPkcs8(pem) });
    const [h, p, s] = jwt.split(".");
    const verifier = await crypto.subtle.importKey(
      "spki",
      publicKey.export({ type: "spki", format: "der" }),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = Uint8Array.from(atob(s!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", verifier, signature, utf8(`${h}.${p}`))).toBe(true);
    expect(JSON.parse(atob(p!))).toMatchObject({ iss: 123 });
  });
});

describe("admin form origin check", () => {
  const post = (headers: Record<string, string>) => new Request("https://tidy.example.workers.dev/admin/keys", { method: "POST", headers });
  const origin = "https://tidy.example.workers.dev";

  test("accepts the admin's own form, including the Origin: null that no-referrer pages send", () => {
    expect(isSameOrigin(post({ origin }), origin)).toBe(true);
    expect(isSameOrigin(post({ origin: "null", "sec-fetch-site": "same-origin" }), origin)).toBe(true);
  });

  test("rejects other sites, even when they hide their origin", () => {
    expect(isSameOrigin(post({ origin: "https://evil.test", "sec-fetch-site": "same-origin" }), origin)).toBe(false);
    expect(isSameOrigin(post({ origin: "null", "sec-fetch-site": "cross-site" }), origin)).toBe(false);
    expect(isSameOrigin(post({}), origin)).toBe(false);
  });
});

describe("webhooks", () => {
  test("accepts only the exact HMAC signature", async () => {
    const body = '{"a":1}';
    const key = await crypto.subtle.importKey("raw", utf8("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hex = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await signatureMatches("s3cret", body, `sha256=${hex}`)).toBe(true);
    expect(await signatureMatches("s3cret", `${body} `, `sha256=${hex}`)).toBe(false);
    expect(await signatureMatches("other", body, `sha256=${hex}`)).toBe(false);
    expect(await signatureMatches("s3cret", body, null)).toBe(false);
  });

  const base = { installation: { id: 1 }, repository: { id: 5, full_name: "alice/app" } };
  const human = { login: "bob", type: "User" };
  const bot = "alice-tidy[bot]";

  test("starts runs for new issues, mentions and ready pull requests", () => {
    expect(classify("issues", { ...base, action: "opened", sender: human, issue: { number: 3, state: "open" } }, bot, "alice/tidy")).toMatchObject({ kind: "issue", number: 3 });
    expect(
      classify(
        "issue_comment",
        { ...base, action: "created", sender: human, issue: { number: 3, state: "open" }, comment: { id: 9, body: "@tidy fix", user: human, author_association: "COLLABORATOR" } },
        bot,
        "alice/tidy",
      ),
    ).toMatchObject({ kind: "command", commentId: 9 });
    expect(classify("pull_request", { ...base, action: "opened", sender: human, pull_request: { number: 4, draft: false } }, bot, "alice/tidy")).toMatchObject({ kind: "review" });
  });

  test("the tidy:review label asks for a review of any pull request, even a bot's", () => {
    const labeled = (name: string) =>
      classify("pull_request", { ...base, action: "labeled", sender: { login: "renovate[bot]", type: "Bot" }, label: { name }, pull_request: { number: 7, draft: false } }, bot, "alice/tidy");
    expect(labeled("tidy:review")).toMatchObject({ kind: "review", number: 7, requested: true, trusted: true });
    expect(labeled("dependencies")).toBeNull();
  });

  test("commands from people without write access are dropped before they use up a run", () => {
    const comment = (author_association: string) =>
      classify(
        "issue_comment",
        { ...base, action: "created", sender: human, issue: { number: 3, state: "open" }, comment: { id: 9, body: "@tidy fix", user: human, author_association } },
        bot,
        "alice/tidy",
      );
    expect(comment("NONE")).toBeNull();
    expect(comment("CONTRIBUTOR")).toBeNull();
    expect(comment("OWNER")).not.toBeNull();
  });

  test("maintainers, the repository owner and tidy itself are trusted; others are not", () => {
    const issue = (sender: { login: string; type: string }, author_association?: string) =>
      classify(
        "issues",
        { ...base, repository: { ...base.repository, owner: { login: "alice" } }, action: "opened", sender, issue: { number: 3, state: "open", author_association } },
        bot,
        "alice/tidy",
      )?.trusted;
    expect(issue(human, "MEMBER")).toBe(true);
    expect(issue({ login: "Alice", type: "User" })).toBe(true);
    expect(issue(human, "NONE")).toBe(false);
    expect(issue(human, "FIRST_TIME_CONTRIBUTOR")).toBe(false);
  });

  test("outsiders meet per-person and per-PR caps; maintainers only the safety caps", () => {
    const limits = { runs_per_day: 300, runs_per_repo_per_day: 100, outsider_events_per_day: 10, outsider_pushes_per_pr_per_day: 6 };
    const push = { repo: "Alice/App", repoId: 5, kind: "review" as const, number: 4, followUp: true, sender: "Bob" };
    expect(countersFor({ ...push, trusted: true }, limits, "2026-11-12").map((c) => c.key)).toEqual(["runs:2026-11-12", "repo:alice/app:2026-11-12"]);
    expect(countersFor({ ...push, trusted: false }, limits, "2026-11-12")).toEqual([
      { key: "runs:2026-11-12", limit: 300 },
      { key: "repo:alice/app:2026-11-12", limit: 100 },
      { key: "person:bob:2026-11-12", limit: 10 },
      { key: "pushes:alice/app#4:2026-11-12", limit: 6 },
    ]);
  });

  test("new commits start a follow-up review", () => {
    const push = { ...base, action: "synchronize", sender: human, pull_request: { number: 4, draft: false } };
    expect(classify("pull_request", push, bot, "alice/tidy")).toMatchObject({ kind: "review", followUp: true });
    expect(classify("pull_request", { ...push, action: "opened" }, bot, "alice/tidy")).not.toHaveProperty("followUp");
  });

  test("reviews its own pull requests but ignores other bots and itself elsewhere", () => {
    const ownPr = { ...base, action: "opened", sender: { login: bot, type: "Bot" }, pull_request: { number: 4, draft: false } };
    expect(classify("pull_request", ownPr, bot, "alice/tidy")).toMatchObject({ kind: "review" });
    expect(classify("pull_request", { ...ownPr, sender: { login: "renovate[bot]", type: "Bot" } }, bot, "alice/tidy")).toBeNull();
    const ownComment = { ...base, action: "created", sender: { login: bot, type: "Bot" }, issue: { number: 3, state: "open" }, comment: { id: 1, body: "@tidy fix", user: { type: "Bot" } } };
    expect(classify("issue_comment", ownComment, bot, "alice/tidy")).toBeNull();
  });

  test("ignores ordinary comments, drafts, closed pull requests and the tidy repository itself", () => {
    const comment = { ...base, action: "created", sender: human, issue: { number: 3, state: "open" }, comment: { id: 9, body: "thanks @tidy", user: human } };
    expect(classify("issue_comment", comment, bot, "alice/tidy")).toBeNull();
    expect(classify("pull_request", { ...base, action: "opened", sender: human, pull_request: { number: 4, draft: true } }, bot, "alice/tidy")).toBeNull();
    expect(classify("pull_request", { ...base, action: "closed", sender: human, pull_request: { number: 4, draft: false } }, bot, "alice/tidy")).toBeNull();
    const own = { ...base, repository: { id: 1, full_name: "Alice/Tidy" }, action: "opened", sender: human, issue: { number: 1, state: "open" } };
    expect(classify("issues", own, bot, "alice/tidy")).toBeNull();
  });
});
