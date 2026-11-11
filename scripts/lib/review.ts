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

export const VERDICTS = { ready: "✅ Ready to merge", changes: "⚠️ Needs changes", comments: "💬 Comments" } as const;

export interface Review {
  verdict: keyof typeof VERDICTS;
  summary: string;
  findings: string[];
  /** Earlier findings the new commits resolved; only in follow-up reviews. */
  fixed: string[];
  checks: string;
  checked: string[];
  comments: ReviewComment[];
}

const item = (text: string) => sanitize(text, 1500).replace(/\s*\n\s*/g, " ");
const items = (value: unknown, max = 20) =>
  (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, max).map(item);

/** Keeps only comments that point at lines in this diff; the rest become findings. */
export function validateReview(raw: unknown, diff: string): Review {
  const value = raw as Partial<Record<keyof Review, unknown>>;
  if (!value || typeof value.summary !== "string") throw new Error("Review result needs a summary");
  const valid = commentableLines(diff);
  const comments: ReviewComment[] = [];
  const findings = items(value.findings);
  for (const entry of Array.isArray(value.comments) ? value.comments.slice(0, MAX_COMMENTS) : []) {
    const comment = entry as Partial<ReviewComment>;
    if (typeof comment.path !== "string" || !Number.isInteger(comment.line) || typeof comment.body !== "string") continue;
    const body = sanitize(comment.body, 4000);
    if (!body) continue;
    if (valid.get(comment.path)?.has(comment.line!)) comments.push({ path: comment.path, line: comment.line!, body });
    else findings.push(item(`\`${comment.path.replace(/`/g, "")}:${comment.line}\`: ${body}`));
  }
  return {
    verdict: value.verdict === "ready" || value.verdict === "changes" ? value.verdict : "comments",
    summary: sanitize(value.summary, 2000),
    findings,
    fixed: items(value.fixed),
    checks: typeof value.checks === "string" ? sanitize(value.checks, 3000) : "",
    checked: items(value.checked),
    comments,
  };
}

/** The same layout for every review, so the verdict and findings are easy to scan. */
export function renderReview(review: Review, options: { followUp: boolean; extras: string }): string {
  const list = (title: string, entries: string[]) => (entries.length ? `**${title}**\n${entries.map((e) => `- ${e}`).join("\n")}` : "");
  const parts = [
    `**${VERDICTS[review.verdict]}**`,
    review.summary,
    list("Fixed since the last review", review.fixed),
    list(options.followUp ? "Still open or new" : "Findings", review.findings),
    review.checks ? `**Checks**\n${review.checks}` : "",
    options.extras,
    review.checked.length
      ? `<details><summary>What I checked</summary>\n\n${review.checked.map((e) => `- ${e}`).join("\n")}\n\n</details>`
      : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}
