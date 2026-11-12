const MAX = 60_000;
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;
// A backslash before the opening backtick makes it literal on GitHub, so that is not code.
const SPAN = /(?<![`\\])(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g;

/** The text GitHub renders as Markdown, with code blocks and spans removed. */
export const withoutCode = (text: string) => text.replace(/\r\n?/g, "\n").replace(FENCE, "").replace(SPAN, "");
const LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g;

function clean(text: string): string {
  let out = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image removed: $1]");
  out = out.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "[image removed: $1]");
  out = out.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");
  // Every tag is escaped: even a harmless one alone on a line starts an HTML block, where code spans
  // stop being code. GFM allows newlines inside a tag, so match across lines.
  out = out.replace(/<[^>]*>?/g, (tag) => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  out = out.replace(LINK, (whole, label: string, url: string) => (isGitHub(url) ? whole : `${label} (link removed)`));
  return out;
}

/**
 * Makes model-written Markdown safe to post as the bot: no pings, no images or embeds that could
 * leak data through URLs, no links outside GitHub, and no keywords that close other issues.
 */
export function sanitize(text: string, max = MAX): string {
  let out = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  // GitHub renders nothing inside code, so code is set aside untouched; otherwise `a <= b` would show `&lt;`.
  // Control characters were stripped above, so the placeholders cannot be forged.
  const code: string[] = [];
  const keep = (match: string) => `\u0000${code.push(match) - 1}\u0000`;
  out = out.replace(FENCE, keep).replace(SPAN, keep);
  // Nested constructs like [![x](a)](b) only surface after one pass, so repeat until stable.
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = clean(out);
  }
  out = out.replace(/(?:\bhttps?:)?\/\/[^\s)<>\]"'`]+/gi, (url) => (isGitHub(url) ? url : "`[link removed]`"));
  out = out.replace(/\bwww\.[^\s)<>\]"'`]+/gi, "`[link removed]`");
  out = out.replace(/(^|[^\w`/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g, "$1@​$2");
  out = out.replace(
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)((?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/)|(?:[\w.-]+\/[\w.-]+)?#)(\d+)/gi,
    "$1$2$3​$4",
  );
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)] ?? "");
  if (out.length > max) out = `${out.slice(0, max - 40)}\n\n…(truncated)`;
  return out.trim();
}

function isGitHub(url: string): boolean {
  if (url === "" || url.startsWith("#")) return true;
  if (url.startsWith("/")) return !url.startsWith("//");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "github.com" || parsed.hostname === "docs.github.com");
  } catch {
    return false;
  }
}

export function singleLine(text: string, max: number): string {
  return sanitize(text.replace(/\s+/g, " "), max).replace(/\n/g, " ");
}
