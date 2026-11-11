const MAX = 60_000;
const ALLOWED_TAGS = /^<\/?(details|summary|br|b|i|em|strong|code|kbd|sub|sup)\s*\/?>$/i;

/**
 * Makes model-written Markdown safe to post as the bot: no pings, no images or embeds that could
 * leak data through URLs, no links outside GitHub, and no keywords that close other issues.
 */
export function sanitize(text: string, max = MAX): string {
  let out = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image removed: $1]");
  out = out.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "[image removed: $1]");
  out = out.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");
  out = out.replace(/<[^>\n]*>/g, (tag) => (ALLOWED_TAGS.test(tag) ? tag : tag.replace(/</g, "&lt;").replace(/>/g, "&gt;")));
  out = out.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (whole, label: string, url: string) =>
    isGitHub(url) ? whole : `${label} (link removed)`,
  );
  out = out.replace(/\bhttps?:\/\/[^\s)<>\]]+/g, (url) => (isGitHub(url) ? url : "`[link removed]`"));
  out = out.replace(/(^|[^\w`/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g, "$1@​$2");
  out = out.replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)((?:[\w.-]+\/[\w.-]+)?#)(\d+)/gi, "$1$2$3​$4");
  if (out.length > max) out = `${out.slice(0, max - 40)}\n\n…(truncated)`;
  return out.trim();
}

function isGitHub(url: string): boolean {
  if (url.startsWith("#") || url.startsWith("/") || url === "") return !url.startsWith("//");
  try {
    const host = new URL(url).hostname;
    return new URL(url).protocol === "https:" && (host === "github.com" || host === "docs.github.com");
  } catch {
    return false;
  }
}

export function singleLine(text: string, max: number): string {
  return sanitize(text.replace(/\s+/g, " "), max).replace(/\n/g, " ");
}
