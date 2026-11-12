# How tidy works

tidy runs on GitHub Actions in your copy of this repository, plus a small Cloudflare Worker that
receives GitHub webhooks and holds the keys. The agent is [OpenCode](https://opencode.ai).

```text
GitHub event ──▶ Worker ──repository_dispatch──▶ tidy workflows in your tidy repository
(issue, PR,       checks the signature,           gate     reads the thread, decides trust, snapshots the code
 @tidy comment)   holds the App key and           issue    triage, then a fix or reply, in one job
                  model keys, applies the         plan     picks arguments for review extras
                  run limits                      review   OpenCode in a container
                      │                           checks   your repo's tests, no credentials at all
                      └── per-job credentials ─── publish  the only job with write access
```

## Credentials

Each job asks the Worker for exactly what it needs by presenting its GitHub Actions OIDC token. The
Worker checks which workflow file the job runs and hands out:

| Workflow | Gets |
| --- | --- |
| `gate.yml` | a read-only token for the target repository |
| `agent.yml` | the model keys, and no GitHub token |
| `publish.yml` | a token that can push a new branch and comment, for one repository, a few times per run |
| `checks.yml` | nothing |

Credentials are encrypted to a key that exists only inside the requesting job (X25519 and AES-GCM), and
the OIDC token is bound to that key, so a leaked OIDC token is useless.

## Issues

1. The Worker checks the [run limits](configuration.md#limits), reacts with 👀 and starts a run. Once the
   gate decides to look at the issue, tidy comments that it is on it, with a link to the run. If it then
   leaves the issue alone, for example as spam, it deletes that comment.
2. The gate reads the thread and decides whether everyone in it can already push to the repository.
3. Triage classifies the issue by kind and size, and a [route](configuration.md#routes) picks the
   action: fix, reply, a security notice, or nothing. The fix or reply runs in the same job, as a
   separate OpenCode session.
4. For a fix, OpenCode edits a copy of the code. It gets a shell only when the whole thread comes from
   people with write access.
5. `publish.yml` checks the patch again, pushes a new `tidy/issue-…` branch, opens the pull request and
   comments on the issue. The 👀 becomes 🚀, or 😕 with a comment and a link to the run when
   something failed.

When the model provider refuses tidy's key, for example because the plan's usage is used up, tidy says
so on the issue or pull request, mentions the tidy admin, and changes nothing.

The commit credits the issue author with a `Reported-by:` trailer for bugs, or `Suggested-by:` for
anything else, and the pull request thanks them. tidy does not use `Co-authored-by:`, because the issue
author did not write the code.

## Pull requests

Pull requests are reviewed when they open, reopen or leave draft. Reviews start with a verdict, list
findings, report the [checks](configuration.md#reviews), and put inline comments on the changed lines.
For small, certain fixes an inline comment carries a GitHub suggestion that the author can commit with
one click. [Review extras](extras.md) can add files such as before and after GIFs.

New commits get a follow-up review of just those commits, which says what they fixed and what is still
open. A push during a review cancels it, so a burst of commits gets one review. A pull request from
someone without write access gets at most `review.max_auto_reviews` automatic reviews, and at most
`limits.outsider_pushes_per_pr_per_day` follow-ups a day; after that a maintainer can comment
`@tidy review`. Maintainers' pull requests have no such caps.

## Commands

Comment on an issue or pull request. Only people with write access can run commands.

| Comment | Effect |
| --- | --- |
| `@tidy fix` | Attempt a fix for an issue, even one triaged as a question |
| `@tidy review` | Review the pull request again |
| `@tidy publish` | Open the pull request for a patch tidy posted for approval (within 7 days) |

tidy skips pull requests from other bots, such as Renovate or Dependabot. Add the `tidy:review` label to
one to have it reviewed; adding labels needs triage access, so this counts like a maintainer's command.
Renovate can add the label itself, for example to major updates:

```json
{ "matchUpdateTypes": ["major"], "automerge": false, "addLabels": ["tidy:review"] }
```

## Fixes from outside issues

Pull requests from tidy are branches in your repository, so your CI runs on them like on your own
branches, including any secrets it uses. That is fine for ordinary CI, but a fix written from an
outsider's issue could be steered into code that leaks those secrets.

So when an issue thread includes text from people without write access, tidy reads your workflows first.
If none of them use secrets on pull requests or on pushes to tidy's branches, it opens the pull request
right away, with a
`tidy: untrusted` label and a warning. If some do, it posts the patch as a comment instead, and a
maintainer opens the pull request by commenting `@tidy publish`. The comment pins the patch by its hash,
so only what you read gets published. Workflows listed in
[`safe_workflows`](configuration.md#fixes-from-outside-issues) are not counted.
