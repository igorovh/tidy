# Security model

tidy assumes the model can be talked into anything, and limits what it can do instead.

- **Write access lives in one place.** Only `publish.yml` gets a token that can write, and it runs tidy's
  code on artifacts, never repository or agent code. The App has no `workflows` permission, so it cannot
  change CI, and the [recommended ruleset](setup.md#protect-your-default-branches) keeps it from merging
  or pushing to the default branch. Reviews are always posted as comments, so tidy cannot satisfy a
  required approval.
- **The agent runs in a container** that sees the workspace, a snapshot of the thread and its result
  file. It has no GitHub token, and the runner's OIDC and artifact tokens are not passed in.
  System-level OpenCode policies deny everything the task does not need and block project
  `opencode.json` files, which could redirect the model key.
- **Shell access is earned.** The agent gets a shell only when every author in the thread can already
  push to the repository. Otherwise it can read and edit files only.
- **Triage cannot act.** The first model to read an issue has no tools and can only answer with a kind
  and a size from a fixed list.
- **Patches are checked twice.** After the agent and again in `publish.yml`, using a git directory the
  agent never saw: no protected paths (`.github/`, `opencode.json`, `.npmrc` and more), no symlinks or
  submodules, at most 100 files and 5 MB. Patches are staged with `git apply --cached` and never run.
- **Output is cleaned.** Mentions, images, HTML tags and links outside GitHub (including `//host` and
  `www.` links) are removed from everything tidy posts; code is left as written. Closing keywords cannot
  close other issues. Suggestions are fenced so their code cannot escape the block.
- **Outside input never reaches secrets unseen.** Fixes from threads with outside text wait for
  `@tidy publish` when the repository's pull request workflows use secrets (see
  [How it works](how-it-works.md#fixes-from-outside-issues)).
- **Checks and extras have no credentials.** They run pull request code in a container without secrets
  or tokens. Their commands come from the default branch; the model only picks extra arguments, passed
  as a list.
- **Abuse limits.** People without write access get at most two issues or pull requests a day handled,
  each pull request gets a limited number of automatic reviews, and the Worker caps workflow runs per
  day (`DAILY_RUN_LIMIT` in `wrangler.jsonc`).
- **The Worker** verifies webhook signatures and stores keys encrypted with a master key kept as a Worker
  secret. `/admin` uses GitHub sign-in (PKCE, admins of the tidy repository only, one-hour sessions,
  CSRF tokens). Keys can be replaced but never read back, and every change opens an issue in your tidy
  repository.

## Known limits

- A trusted fix has a shell and the model key in the same container, so a prompt injection in a
  maintainer-written thread could leak the model key. It cannot push anything.
- Run logs in your tidy repository show the target repositories' content. Keep tidy private if it serves
  private repositories; private repositories use Actions minutes.
- The `tidy-assets` branch is public in public repositories, like the reviews that link to it.
- Protect your GitHub and Cloudflare accounts with 2FA. Whoever controls them controls the bot.

Found a problem? Please report it privately through the repository's Security tab.
