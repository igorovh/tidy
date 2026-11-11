import { handleAdmin } from "./admin";
import { handleRepos } from "./api";
import type { Env } from "./env";
import { page } from "./html";
import { handleSetup, handleSetupCallback } from "./setup";
import { handleToken } from "./token";
import { handleWebhook } from "./webhook";

export { TidyState } from "./state";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    try {
      if (url.pathname === "/webhook" && request.method === "POST") return await handleWebhook(request, env, origin);
      if (url.pathname === "/token" && request.method === "POST") return await handleToken(request, env);
      if (url.pathname === "/api/repos" && request.method === "GET") return await handleRepos(request, env);
      if (url.pathname === "/setup" && request.method === "GET") return await handleSetup(request, env, origin);
      if (url.pathname === "/setup/callback" && request.method === "GET") return await handleSetupCallback(request, env);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await handleAdmin(request, env, origin);
      if (url.pathname === "/") return page("tidy", `<p>This Worker runs a tidy instance. Admins: <a href="/admin">/admin</a>.</p>`);
      return new Response("not found", { status: 404 });
    } catch (error) {
      // Details go to Workers logs only; responses never echo internal errors.
      console.error(error);
      return new Response("internal error", { status: 500 });
    }
  },
};
