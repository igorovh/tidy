export const escape = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function page(title: string, body: string, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="no-referrer"><title>${escape(title)} · tidy</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1f2328}
input,button,select{font:inherit;padding:.4rem .6rem}input[type=text],input[type=password]{width:100%;box-sizing:border-box}
button{cursor:pointer}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3rem .5rem;border-bottom:1px solid #d0d7de}
code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}.muted{color:#59636e}.box{border:1px solid #d0d7de;border-radius:8px;padding:1rem;margin:1rem 0}</style>
</head><body><h1>${escape(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
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
