# tidy

A GitHub bot you run yourself. When someone opens an issue, tidy decides what kind of issue it is, then
answers it or proposes a fix as a pull request. When a pull request opens, it reviews it. It never pushes
to your default branch, and no repository needs a secret.

tidy runs on GitHub Actions in your copy of this repository, plus a small Cloudflare Worker (free plan)
that receives GitHub webhooks and holds the keys. The agent is [OpenCode](https://opencode.ai).

**Feel free to try it yourself in [tidy-playground](https://github.com/igorovh/tidy-playground):** open
an issue about one of its bugs and watch tidy triage it, open a fix and review it.

## How it works

```text
GitHub event ──▶ Worker ──repository_dispatch──▶ tidy workflows in your tidy repository
(issue, PR,       checks the signature,           gate     reads the thread, decides trust, snapshots the code
 @tidy comment)   holds the App key and           triage   a model with no tools classifies the issue
                  model keys                      fix / reply / review   OpenCode in a container
                      ▲                           checks   your repo's tests, no credentials at all
                      └── per-job credentials ─── publish  the only job with write access
```

Each job asks the Worker for exactly what it needs by presenting its GitHub Actions OIDC token. The
Worker checks which workflow file the job runs and hands out:

| Workflow | Gets |
| --- | --- |
| `gate.yml` | a read-only token for the target repository |
| `agent.yml` | the model keys, and no GitHub token |
| `publish.yml` | a token that can push a new branch and comment, for one repository, a few times per run |
| `checks.yml` | nothing |

Credentials are encrypted to a key that exists only inside the requesting job (X25519 + AES-GCM),
and the OIDC token is bound to that key, so a leaked OIDC token is useless.

## Set up your own

You need a GitHub account, a free Cloudflare account and a model key, for example
[OpenCode Go](https://opencode.ai/docs/console/go/).

1. Click **Use this template** to create your own repository (public, so Actions minutes are free).
2. Clone it, run `bun install`, then `bunx wrangler login`.
3. Run `bun run deploy`. It deploys the Worker, creates its master key and prints a setup link.
4. Open the link and click **Create GitHub App**. GitHub creates the App and gives its key straight to
   the Worker; you never download it. Then install the App, ideally on **All repositories**, and make
   sure your tidy repository is included.
5. Open `https://<your-worker>/admin`, sign in with GitHub and save your model key, for example as
   `OPENCODE_API_KEY`.

### Protect your default branches (recommended)

The App needs write access to push pull request branches, and GitHub would let that access merge or
push to your default branch too. tidy never does, but a ruleset that requires an approved pull
request makes it impossible. Add it to many repositories at once with your own `gh` login:

```sh
bun run protect                                  # pick repositories interactively
bun run protect -- --repo you/app --apply        # one repository, no prompts
```

The picker lists your repositories, marks the ones tidy is installed on (it asks your Worker, which
checks with your `gh` token that you administer the tidy repository), and lets you choose all of
them, only those with tidy, or pick by typing to filter and pressing space. It shows a plan and asks
before changing anything. It skips forks, archived repositories and repositories that already
require an approval, never changes your existing rulesets, and gives Renovate a bypass where
Renovate automerges. Admins of a
repository can still merge their own pull requests. Run it again after creating new repositories.

Without the ruleset, tidy still opens pull requests and adds a note with the command. Set
`require_ruleset: true` in `tidy.yml` to make tidy refuse instead. tidy cannot add rulesets itself,
because that needs an administration permission much broader than the one it protects against.

### Fixes for outside issues

Pull requests from tidy are branches in your repository, so your CI runs on them like on your own
branches, including any secrets it uses. That is fine for ordinary CI, but a fix written from an
outsider's issue could be steered into code that leaks those secrets.

So when an issue thread includes text from people without write access, tidy reads your workflows
first. If none of them run on pull requests with secrets, it opens the pull request right away. If some
do, it posts the patch as a comment instead, and a maintainer opens the pull request by commenting
`@tidy publish`. The comment pins the patch by its hash, so only what you read gets published. You do
not need to configure anything for this.

### Adding repositories

With **All repositories**, new repositories work right away. To exclude one, add `.github/tidy.yml`
with `enabled: false`. Otherwise, add repositories under **Add repositories** in `/admin`, which opens
GitHub's App installation page.

## Configure

[`tidy.yml`](tidy.yml) holds your instance's defaults: which models are allowed, the triage model,
routes from issue kinds to actions, review settings and limits. A repository can override triage,
routes, review settings and add protected paths in `.github/tidy.yml` on its default branch, within
the models your instance allows:

```yaml
review:
  checks: ["bun install --frozen-lockfile", "bun test"]
routes:
  - when: { kind: [bug], size: [small, medium] }
    action: fix
    model: opencode-go/kimi-k3.1-pro
```

Keys live only in the Worker. Change models in `tidy.yml`; change keys in `/admin`.

### Commands

Comment on an issue or pull request. Only people with write access can run commands.

| Comment | Effect |
| --- | --- |
| `@tidy fix` | Attempt a fix for an issue, even one triaged as a question |
| `@tidy publish` | Open the pull request for a patch tidy posted for approval (within 7 days) |
| `@tidy review` | Review the pull request again |
| `@tidy review deep` | Review with `review.deep_model` |

tidy reacts with 👀 as soon as it sees an issue, pull request or command, and swaps it for 🚀 when it
has posted its answer, or 😕 with a link to the run when something failed. After opening a pull
request it also comments on the issue.

New pull requests are reviewed when they open or leave draft. Pushes do not trigger a new review;
comment `@tidy review` instead.

## Security model

tidy assumes the model can be talked into anything, and limits what it can do instead.

- **Write access lives in one place.** Only `publish.yml` gets a token that can write, and it runs
  tidy's code on artifacts, never repository or agent code. The App has no `workflows` permission, so
  it cannot change CI, and the recommended ruleset keeps it from merging or pushing to the default branch.
  Reviews are always posted as comments, so tidy cannot satisfy a required approval.
- **The agent runs in a container** that sees the workspace, a snapshot of the thread and its result
  file. It has no GitHub token, and the runner's OIDC and artifact tokens are not passed in.
  System-level OpenCode policies deny everything the task does not need and block project
  `opencode.json` files, which could redirect the model key.
- **Shell access is earned.** The agent gets a shell only when every author in the thread can already
  push to the repository. Otherwise it can read and edit files only.
- **Triage cannot act.** The first model to read an issue has no tools and can only answer with a
  kind and a size from a fixed list.
- **Patches are checked twice.** After the agent and again in `publish.yml`, using a git directory the
  agent never saw: no protected paths (`.github/`, `opencode.json`, `.npmrc` and more), no symlinks or
  submodules, at most 100 files and 5 MB. Patches are staged with `git apply --cached` and never run.
- **Output is cleaned.** Mentions, images, HTML tags (code is left as written), and links outside
  GitHub (including `//host` and `www.` links) are removed from everything tidy posts, and closing
  keywords cannot close other issues.
- **Outside input never reaches secrets unseen.** Fixes from threads with outside text wait for
  `@tidy publish` when the repository's pull request workflows use secrets. Otherwise they get a
  `tidy: untrusted` label and a warning in the pull request.
- **Abuse limits.** tidy skips fixes for people without write access after two issues from them in a
  day, and the Worker caps workflow runs per day (`DAILY_RUN_LIMIT` in `wrangler.jsonc`).
- **The Worker** verifies webhook signatures, stores keys encrypted with a master key kept as a
  Worker secret, and protects `/admin` with GitHub sign-in (PKCE, admins of the tidy repository only,
  one-hour sessions, CSRF tokens). Keys can be replaced but never read back, and every change opens
  an issue in your tidy repository.

Known limits:

- A trusted fix has a shell and the model key in the same container, so a prompt injection by a
  maintainer-written thread could leak the model key. It cannot push anything.
- Run logs in your tidy repository show the target repositories' content. Keep tidy private if it
  serves private repositories; private repositories use Actions minutes.
- Protect your GitHub and Cloudflare accounts with 2FA. Whoever controls them controls the bot.

## Update

Your copy does not follow this template automatically. To pull fixes, add this repository as a
remote and merge, then run `bun run deploy` again:

```sh
git remote add upstream https://github.com/igorovh/tidy.git
git pull upstream main
bun run deploy
```

## Develop

```sh
bun install
bun run typecheck
bun test
bunx wrangler dev   # needs TIDY_MASTER_KEY in .dev.vars
```
