import { KINDS, type Kind } from "./config";

export interface IssueAuthor {
  login: string;
  id: number;
}

const kindOf = (kind: unknown): Kind | undefined => (KINDS.includes(kind as Kind) ? (kind as Kind) : undefined);

/**
 * Credits the issue author without claiming they wrote the code: Co-authored-by would put them on the
 * commit as an author, so a bug report gets Reported-by and anything else Suggested-by.
 */
export function commitMessage(title: string, issue: number, author: IssueAuthor, kind: unknown): string {
  const trailer = kindOf(kind) === "bug" ? "Reported-by" : "Suggested-by";
  return [title, "", `Closes #${issue}`, "", `${trailer}: ${author.login} <${author.id}+${author.login}@users.noreply.github.com>`].join("\n");
}

export function thanks(issue: number, author: IssueAuthor, kind: unknown): string {
  return `Thanks @${author.login} for ${kindOf(kind) === "bug" ? "reporting" : "suggesting"} this in #${issue}.`;
}
