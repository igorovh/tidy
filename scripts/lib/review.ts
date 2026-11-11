import { sanitize } from "./sanitize";

export const MAX_COMMENTS = 30;

/** New-file line numbers GitHub accepts inline comments on, per path. */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let next = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      current = path === "/dev/null" ? undefined : new Set();
      if (current) lines.set(path.replace(/^b\//, ""), current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!current || line.startsWith("--- ") || line.startsWith("\\")) continue;
    if (line.startsWith("+") || line.startsWith(" ")) current.add(next++);
  }
  return lines;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface Review {
  summary: string;
  comments: ReviewComment[];
}

/** Keeps only comments that point at lines in this diff; the rest move into the summary. */
export function validateReview(raw: unknown, diff: string): Review {
  const value = raw as { summary?: unknown; comments?: unknown };
  if (!value || typeof value.summary !== "string") throw new Error("Review result needs a summary");
  const valid = commentableLines(diff);
  const comments: ReviewComment[] = [];
  const dropped: string[] = [];
  for (const item of Array.isArray(value.comments) ? value.comments.slice(0, MAX_COMMENTS) : []) {
    const comment = item as Partial<ReviewComment>;
    if (typeof comment.path !== "string" || !Number.isInteger(comment.line) || typeof comment.body !== "string") continue;
    const body = sanitize(comment.body, 4000);
    if (!body) continue;
    if (valid.get(comment.path)?.has(comment.line!)) comments.push({ path: comment.path, line: comment.line!, body });
    else dropped.push(`- \`${comment.path.replace(/`/g, "")}:${comment.line}\`: ${body.replace(/\n+/g, " ")}`);
  }
  const extra = dropped.length ? `\n\n**Notes outside the diff**\n${dropped.join("\n")}` : "";
  return { summary: sanitize(value.summary + extra, 40_000), comments };
}
