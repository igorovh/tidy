// Deploys the Worker, creates TIDY_MASTER_KEY on first run, and prints the one-time setup link.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { b64url, utf8 } from "../shared/encoding";

const resetKey = process.argv.includes("--reset-key");

function wrangler(args: string[], input?: string): string {
  const result = spawnSync("bunx", ["wrangler", ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`wrangler ${args[0]} failed`);
  return result.stdout;
}

function originRepo(): string {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  return result.stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)?.[1] ?? "";
}

const deployed = wrangler(["deploy"]);
process.stdout.write(deployed);
const url = deployed.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
// `bun run protect` reads the Worker address from here; it is not secret, just local.
if (url) writeFileSync(".tidy.json", `${JSON.stringify({ worker: url }, null, 2)}\n`);
const base = url ?? "https://<your-worker>.workers.dev";
const adminLink = () => console.log(`Admin page (model keys, adding repositories): ${base}/admin\n`);

const secrets = JSON.parse(wrangler(["secret", "list", "--format", "json"]) || "[]") as { name: string }[];
if (secrets.some((secret) => secret.name === "TIDY_MASTER_KEY") && !resetKey) {
  console.log("\nTIDY_MASTER_KEY already exists, so the Worker keeps its data.");
  console.log("Lost the setup link before finishing setup? Run `bun run deploy -- --reset-key`.");
  console.log("That makes stored data unreadable, so only use it before the GitHub App exists.\n");
  adminLink();
  process.exit(0);
}

const master = b64url(crypto.getRandomValues(new Uint8Array(32)));
wrangler(["secret", "put", "TIDY_MASTER_KEY"], master);

// Mirrors worker/crypto.ts: the setup code is an HMAC of the master key, so it stops mattering once setup is done.
const material = await crypto.subtle.importKey("raw", Buffer.from(master, "base64url"), "HKDF", false, ["deriveKey"]);
const mac = await crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8("tidy-mac-v1") },
  material,
  { name: "HMAC", hash: "SHA-256", length: 256 },
  false,
  ["sign"],
);
const code = b64url(await crypto.subtle.sign("HMAC", mac, utf8("setup|bootstrap")));
const repo = originRepo();
console.log(`\nOpen this link to create your GitHub App (it works until setup is finished):\n`);
console.log(`${base}/setup?code=${code}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}\n`);
adminLink();
