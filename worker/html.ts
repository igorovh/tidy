export const escape = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d0d7de;--code:#f6f8fa;--link:#0969da;color-scheme:light}
:root[data-theme=dark]{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--code:#151b23;--link:#4493f8;color-scheme:dark}
body{font:15px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;background:var(--bg);color:var(--fg)}
a{color:var(--link)}input,button,select{font:inherit;padding:.4rem .6rem;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
input[type=text],input[type=password]{width:100%;box-sizing:border-box}button{cursor:pointer}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3rem .5rem;border-bottom:1px solid var(--line)}
code{background:var(--code);padding:.1rem .3rem;border-radius:4px}.muted{color:var(--muted)}
.box{border:1px solid var(--line);border-radius:8px;padding:1rem;margin:1rem 0}
#theme{position:fixed;top:1rem;right:1rem}`;

// Runs before the body renders, so a saved dark theme never flashes light.
const THEME = `(()=>{const r=document.documentElement,k="tidy-theme";
const apply=t=>{r.dataset.theme=t;const b=document.getElementById("theme");if(b)b.textContent=t==="dark"?"☀️ Light":"🌙 Dark"};
apply(localStorage.getItem(k)||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));
addEventListener("DOMContentLoaded",()=>{apply(r.dataset.theme);document.getElementById("theme").addEventListener("click",()=>{
const t=r.dataset.theme==="dark"?"light":"dark";localStorage.setItem(k,t);apply(t)})})})()`;

export function page(title: string, body: string, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "form-action 'self' https://github.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="same-origin"><title>${escape(title)} · tidy</title><style>${STYLE}</style>
<script nonce="${nonce}">${THEME}</script></head><body><button id="theme" type="button">🌙 Dark</button>
<h1>${escape(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

// Browsers send `Origin: null` on POSTs from no-referrer pages; Sec-Fetch-Site still tells us the truth.
export function isSameOrigin(request: Request, origin: string): boolean {
  const header = request.headers.get("origin");
  if (header && header !== "null") return header === origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function cookie(name: string, value: string, maxAge: number, sameSite: "Strict" | "Lax", path = "/admin"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
