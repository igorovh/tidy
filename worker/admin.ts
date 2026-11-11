import { b64url, sha256, utf8 } from "../shared/encoding";
import { deriveKeys, mac, macMatches, signValue, verifyValue } from "./crypto";
import { type Env, type Instance, stateOf } from "./env";
import { github, GitHubError, installationToken } from "./github";
import { cookie, escape, page, readCookie } from "./html";
import { loadInstance, resolveRepo, saveInstance } from "./instance";

const SESSION = "__Host-tidy-session";
const OAUTH = "__Host-tidy-oauth";
const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

interface Session {
  uid: number;
  login: string;
  sid: string;
}

const notConfigured = () => page("Not set up", "<p>Run the setup link printed by <code>bun run deploy</code> first.</p>", { status: 503 });

// __Host- cookies must use Path=/; SameSite=Lax lets the state cookie survive GitHub's redirect.
const hostCookie = (name: string, value: string, maxAge: number, sameSite: "Strict" | "Lax") =>
  cookie(name, value, maxAge, sameSite, "/");

async function session(request: Request, env: Env): Promise<Session | null> {
  return verifyValue<Session>(await deriveKeys(env.TIDY_MASTER_KEY), "session", readCookie(request, SESSION));
}

export async function handleAdmin(request: Request, env: Env, origin: string): Promise<Response> {
  const instance = await loadInstance(env);
  if (!instance) return notConfigured();
  const path = new URL(request.url).pathname;
  if (path === "/admin/login") return login(request, env, instance, origin);
  if (path === "/admin/callback") return callback(request, env, instance, origin);
  const current = await session(request, env);
  if (request.method === "POST") {
    if (request.headers.get("origin") !== origin) return page("Forbidden", "<p>Cross-site request.</p>", { status: 403 });
    if (!current) return Response.redirect(`${origin}/admin`, 303);
    const form = await request.formData();
    const keys = await deriveKeys(env.TIDY_MASTER_KEY);
    if (!(await macMatches(keys, "csrf", current.sid, String(form.get("csrf") ?? "")))) {
      return page("Forbidden", "<p>The form expired. Reload the page.</p>", { status: 403 });
    }
    if (path === "/admin/logout") {
      return new Response(null, { status: 303, headers: { location: `${origin}/admin`, "set-cookie": hostCookie(SESSION, "", 0, "Strict") } });
    }
    if (path === "/admin/keys") return updateKey(form, env, instance, current, origin);
    return page("Not found", "", { status: 404 });
  }
  if (!current) {
    return page(
      "tidy admin",
      `<p>Sign in with a GitHub account that has admin access to <code>${escape(instance.repo.fullName)}</code>.</p>
<p><a href="/admin/login">Sign in with GitHub</a></p>`,
    );
  }
  return dashboard(env, instance, current);
}

async function login(request: Request, env: Env, instance: Instance, origin: string): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const hour = new Date().toISOString().slice(0, 13);
  if (!(await stateOf(env).take(`login:${ip}:${hour}`, 20, 7_200_000))) {
    return page("Too many attempts", "<p>Try again in an hour.</p>", { status: 429 });
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const signed = await signValue(await deriveKeys(env.TIDY_MASTER_KEY), "oauth", { state, verifier }, 600);
  const challenge = b64url(await sha256(utf8(verifier)));
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: instance.app.clientId,
    redirect_uri: `${origin}/admin/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    allow_signup: "false",
  }).toString();
  return new Response(null, { status: 302, headers: { location: authorize.toString(), "set-cookie": hostCookie(OAUTH, signed, 600, "Lax") } });
}

async function callback(request: Request, env: Env, instance: Instance, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const keys = await deriveKeys(env.TIDY_MASTER_KEY);
  const pending = await verifyValue<{ state: string; verifier: string }>(keys, "oauth", readCookie(request, OAUTH));
  if (!pending || pending.state !== url.searchParams.get("state")) return page("Sign-in expired", "<p>Try again.</p>", { status: 400 });

  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "tidy-bot" },
    body: JSON.stringify({
      client_id: instance.app.clientId,
      client_secret: instance.app.clientSecret,
      code: url.searchParams.get("code"),
      redirect_uri: `${origin}/admin/callback`,
      code_verifier: pending.verifier,
    }),
  });
  const { access_token: token } = (await exchange.json()) as { access_token?: string };
  if (!token) return page("Sign-in failed", "<p>GitHub did not return a token.</p>", { status: 400 });
  const user = await github<{ id: number; login: string }>("/user", { token });
  // The user token only proves identity; revoke it right away.
  await fetch(`https://api.github.com/applications/${instance.app.clientId}/token`, {
    method: "DELETE",
    headers: {
      authorization: `Basic ${btoa(`${instance.app.clientId}:${instance.app.clientSecret}`)}`,
      "content-type": "application/json",
      "user-agent": "tidy-bot",
    },
    body: JSON.stringify({ access_token: token }),
  });

  if (!(await isAdmin(env, instance, user.login))) {
    return page("Not allowed", `<p>@${escape(user.login)} is not an admin of ${escape(instance.repo.fullName)}.</p>`, { status: 403 });
  }
  const sid = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const signed = await signValue(keys, "session", { uid: user.id, login: user.login, sid }, 3600);
  // A Strict cookie set during a cross-site redirect is not sent on the next hop, so continue from our own page.
  const response = page("Signed in", `<meta http-equiv="refresh" content="0;url=/admin"><p><a href="/admin">Continue</a></p>`, {
    headers: { "set-cookie": hostCookie(SESSION, signed, 3600, "Strict") },
  });
  response.headers.append("set-cookie", hostCookie(OAUTH, "", 0, "Lax"));
  return response;
}

async function isAdmin(env: Env, instance: Instance, login: string): Promise<boolean> {
  const repo = await resolveRepo(env, instance);
  const token = await installationToken(instance.app, repo.installationId, { metadata: "read" }, [repo.id]);
  try {
    const result = await github<{ permission: string }>(
      `/repos/${repo.fullName}/collaborators/${encodeURIComponent(login)}/permission`,
      { token: token.token },
    );
    return result.permission === "admin";
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

async function dashboard(env: Env, instance: Instance, current: Session): Promise<Response> {
  const csrf = await mac(await deriveKeys(env.TIDY_MASTER_KEY), "csrf", current.sid);
  const rows = Object.entries(instance.keys)
    .map(
      ([name, key]) => `<tr><td><code>${escape(name)}</code></td><td>…${escape(key.value.slice(-4))}</td>
<td class="muted">${escape(key.updated.slice(0, 16).replace("T", " "))} by @${escape(key.by)}</td>
<td><form method="post" action="/admin/keys"><input type="hidden" name="csrf" value="${escape(csrf)}">
<input type="hidden" name="name" value="${escape(name)}"><button name="op" value="delete">Remove</button></form></td></tr>`,
    )
    .join("");
  return page(
    "tidy admin",
    `<p>Signed in as @${escape(current.login)}. App: <a href="https://github.com/apps/${escape(instance.app.slug)}">${escape(instance.app.slug)}</a>
· <a href="https://github.com/apps/${escape(instance.app.slug)}/installations/new">Add repositories</a></p>
<div class="box"><h2>Model keys</h2><p class="muted">Keys can be replaced or removed, never shown. Every change opens an issue in
<code>${escape(instance.repo.fullName)}</code>. Models are chosen in <code>tidy.yml</code>, not here.</p>
<table><tr><th>Variable</th><th>Key</th><th>Changed</th><th></th></tr>${rows || '<tr><td colspan="4" class="muted">No keys yet.</td></tr>'}</table>
<form method="post" action="/admin/keys"><input type="hidden" name="csrf" value="${escape(csrf)}">
<p><label>Environment variable<br><input type="text" name="name" value="OPENCODE_API_KEY" pattern="[A-Z][A-Z0-9_]{1,63}" required></label></p>
<p><label>Key<br><input type="password" name="value" autocomplete="off" required maxlength="4096"></label></p>
<button name="op" value="set">Save key</button></form></div>
<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escape(csrf)}"><button>Sign out</button></form>`,
  );
}

async function updateKey(form: FormData, env: Env, instance: Instance, current: Session, origin: string): Promise<Response> {
  const name = String(form.get("name") ?? "");
  const op = form.get("op");
  if (!KEY_NAME.test(name)) return page("Invalid name", "<p>Use an environment variable name such as OPENCODE_API_KEY.</p>", { status: 400 });
  if (op === "set") {
    const value = String(form.get("value") ?? "").trim();
    if (!value || value.length > 4096 || /\s/.test(value)) return page("Invalid key", "<p>The key is empty or malformed.</p>", { status: 400 });
    instance.keys[name] = { value, updated: new Date().toISOString(), by: current.login };
  } else if (op === "delete") {
    delete instance.keys[name];
  } else {
    return page("Invalid request", "", { status: 400 });
  }
  await saveInstance(env, instance);
  await audit(env, instance, `${op === "set" ? "Set" : "Removed"} model key ${name}`, current.login);
  return Response.redirect(`${origin}/admin`, 303);
}

async function audit(env: Env, instance: Instance, title: string, login: string): Promise<void> {
  const repo = await resolveRepo(env, instance);
  const token = await installationToken(instance.app, repo.installationId, { issues: "write" }, [repo.id]);
  await github(`/repos/${repo.fullName}/issues`, {
    token: token.token,
    method: "POST",
    body: {
      title: `tidy: ${title}`,
      body: `@${login} changed tidy's settings in /admin at ${new Date().toISOString()}.\n\nIf this was not you, sign in to /admin, replace the key at its provider, and review who has admin access to this repository.`,
    },
  });
}
