import { deriveKeys, macMatches, signValue, verifyValue } from "./crypto";
import type { Env } from "./env";
import { github, pkcs1ToPkcs8 } from "./github";
import { escape, page } from "./html";
import { loadInstance, saveInstance } from "./instance";

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const NAME = /^[A-Za-z0-9 ._-]{1,34}$/;

export function manifest(origin: string, repo: string, name: string) {
  return {
    name,
    url: `https://github.com/${repo}`,
    hook_attributes: { url: `${origin}/webhook`, active: true },
    redirect_url: `${origin}/setup/callback`,
    callback_urls: [`${origin}/admin/callback`],
    public: false,
    request_oauth_on_install: false,
    default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
    default_events: ["issues", "issue_comment", "pull_request"],
  };
}

const done = () =>
  page("tidy is already set up", `<p>The GitHub App exists. Manage keys in <a href="/admin">/admin</a>.</p>`, { status: 409 });

export async function handleSetup(request: Request, env: Env, origin: string): Promise<Response> {
  if (await loadInstance(env)) return done();
  const url = new URL(request.url);
  const keys = await deriveKeys(env.TIDY_MASTER_KEY);
  const code = url.searchParams.get("code") ?? "";
  if (!(await macMatches(keys, "setup", "bootstrap", code))) {
    return page("Setup link required", "<p>Open the setup link printed by <code>bun run deploy</code>.</p>", { status: 403 });
  }

  const repo = url.searchParams.get("repo") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const owner = url.searchParams.get("owner_type") === "organization" ? "organization" : "user";
  if (!REPO.test(repo) || !NAME.test(name)) {
    const guess = REPO.test(repo) ? repo : "";
    return page(
      "Set up tidy",
      `<form method="get" action="/setup">
<input type="hidden" name="code" value="${escape(code)}">
<p><label>Repository that runs tidy (this template copy)<br><input type="text" name="repo" placeholder="you/tidy" value="${escape(guess)}" required></label></p>
<p><label>GitHub App name (must be unique on GitHub)<br><input type="text" name="name" value="${escape(guess ? `${guess.split("/")[0]}-tidy` : "")}" required maxlength="34"></label></p>
<p><label>The repository belongs to <select name="owner_type"><option value="user">my personal account</option><option value="organization">an organization</option></select></label></p>
<button>Continue</button></form>`,
    );
  }

  const state = await signValue(keys, "manifest", { repo }, 3600);
  const account = repo.split("/")[0]!;
  const action =
    owner === "organization"
      ? `https://github.com/organizations/${encodeURIComponent(account)}/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  return page(
    "Create the GitHub App",
    `<p>GitHub will create <b>${escape(name)}</b> with the permissions tidy needs and send its key straight to this Worker.
You never download or copy it.</p>
<ul><li>Repository permissions: contents, pull requests and issues (write), metadata (read). No workflows permission.</li>
<li>Events: issues, issue comments, pull requests.</li></ul>
<form method="post" action="${escape(action)}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest(origin, repo, name)))}">
<button>Create GitHub App</button></form>`,
  );
}

export async function handleSetupCallback(request: Request, env: Env): Promise<Response> {
  if (await loadInstance(env)) return done();
  const url = new URL(request.url);
  const keys = await deriveKeys(env.TIDY_MASTER_KEY);
  const state = await verifyValue<{ repo: string }>(keys, "manifest", url.searchParams.get("state"));
  const code = url.searchParams.get("code") ?? "";
  if (!state || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) return page("Setup expired", "<p>Start again from the setup link.</p>", { status: 400 });

  const app = await github<{
    id: number;
    slug: string;
    client_id: string;
    client_secret: string;
    webhook_secret: string;
    pem: string;
    owner: { id: number; login: string };
  }>(`/app-manifests/${code}/conversions`, { method: "POST" });
  await saveInstance(env, {
    app: {
      id: app.id,
      slug: app.slug,
      clientId: app.client_id,
      clientSecret: app.client_secret,
      webhookSecret: app.webhook_secret,
      privateKey: pkcs1ToPkcs8(app.pem),
      ownerId: app.owner.id,
      ownerLogin: app.owner.login,
    },
    repo: { fullName: state.repo },
    keys: {},
  });
  return page(
    "tidy is ready",
    `<ol><li><a href="https://github.com/apps/${escape(app.slug)}/installations/new">Install the App</a>.
Choose <b>All repositories</b> so new repositories work without another step, or pick repositories one by one.
Include <code>${escape(state.repo)}</code>: tidy dispatches its workflows there.</li>
<li>Add your model key in <a href="/admin">/admin</a>, for example <code>OPENCODE_API_KEY</code> for OpenCode Go.</li>
<li>Import <code>rulesets/default-branch.json</code> in each repository's Settings → Rules, so tidy can only propose changes.</li></ol>`,
  );
}
