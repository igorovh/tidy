# Set up your own tidy

You need a GitHub account, a free Cloudflare account and a model key, for example
[OpenCode Go](https://opencode.ai/docs/console/go/). A coding agent can walk you through this with the
[install prompt](agent-prompts.md#install-your-own-tidy).

## Install

1. Click **Use this template** to create your own repository. Keep it public, so Actions minutes are
   free (see [Costs and limits](#costs-and-limits)).
2. Clone it, run `bun install`, then `bunx wrangler login`.
3. Run `bun run deploy`. It deploys the Worker, creates its master key and prints a setup link and the
   link to `/admin`.
4. Open the setup link and click **Create GitHub App**. GitHub creates the App and gives its key straight
   to the Worker; you never download it. Then install the App, ideally on **All repositories**, and make
   sure your tidy repository is included.
5. Open `https://<your-worker>/admin`, sign in with GitHub and save your model key, for example as
   `OPENCODE_API_KEY`. The variable name is the one OpenCode reads for that provider.

Every key change in `/admin` opens an issue in your tidy repository, so a change you did not make does
not go unnoticed. You can close those issues.

## Add repositories

With **All repositories**, new repositories work right away. To exclude one, add `.github/tidy.yml` with
`enabled: false`. Otherwise, add repositories under **Add repositories** in `/admin`, which opens
GitHub's App installation page.

tidy works without any file in the repository. To have it run your tests during reviews, add
`.github/tidy.yml` with `review.checks` (see [Configuration](configuration.md)), or let a coding agent
write it with the [repository prompt](agent-prompts.md#set-up-tidy-for-a-repository).

## Protect your default branches

The App needs write access to push pull request branches, and GitHub would let that access merge or push
to your default branch too. tidy never does, but a ruleset that requires an approved pull request makes
it impossible. Add it to many repositories at once with your own `gh` login:

```sh
bun run protect                                  # pick repositories interactively
bun run protect -- --repo you/app --apply        # one repository, no prompts
```

The picker lists your repositories and marks the ones tidy is installed on. It asks your Worker, which
checks with your `gh` token that you administer the tidy repository. You can choose all repositories,
only those with tidy, or pick by typing to filter and pressing space. It shows a plan and asks before
changing anything.

It skips forks, archived repositories and repositories that already require an approval. It never
changes your existing rulesets, and it gives Renovate a bypass where Renovate automerges. Admins of a
repository can still merge their own pull requests. Run it again after creating new repositories.

Without the ruleset, tidy still opens pull requests and adds a note with the command. Set
`require_ruleset: true` in `tidy.yml` to make tidy refuse instead. tidy cannot add rulesets itself,
because that needs an administration permission much broader than the one it protects against.

## Costs and limits

- **Cloudflare:** the Worker and its Durable Object fit in the free plan. A run makes 4 or 5 requests
  to the Worker, and every GitHub event tidy is subscribed to makes one, even when tidy ignores it.
  On the free plan Cloudflare rejects requests over its limits instead of billing you.
- **GitHub Actions:** free for public repositories. A private tidy repository uses your Actions minutes.
- **Model:** tidy uses Muse Spark on OpenCode Go by default, the cheapest paid model there. You choose
  models in [`tidy.yml`](configuration.md#models). When the provider refuses tidy's key, for example
  because the plan's usage is used up, tidy says so on the issue or pull request and mentions you.
- **Run limits:** safety caps for runs per day, in total and per repository, plus tighter limits for
  people without write access. You set them in [`tidy.yml`](configuration.md#limits), and edits apply
  within 5 minutes without a redeploy.

## Update

Your copy does not follow this template automatically. To pull fixes, add this repository as a remote
and merge, then deploy again:

```sh
git remote add upstream https://github.com/igorovh/tidy.git
git pull upstream main
bun run deploy
```
