# Configuration

tidy reads two files:

- [`tidy.yml`](../tidy.yml) in your tidy repository holds the defaults for the whole instance.
- `.github/tidy.yml` in a repository overrides some of them for that repository. tidy reads it from the
  default branch only, so a pull request cannot change how it is reviewed.

Keys live only in the Worker. Change models here; change keys in `/admin`.

## What a repository can change

| Setting | In `tidy.yml` | In `.github/tidy.yml` |
| --- | --- | --- |
| `enabled` | yes | yes, `false` turns tidy off for the repository |
| `models.allowed` | yes | no |
| `triage.model`, `routes`, `review.model` | yes | yes, within `models.allowed` |
| `review.checks`, `review.image`, `review.extras` | `checks` and `image` | yes |
| `review.on_push` | yes | yes |
| `review.max_auto_reviews`, `limits.outsider_attempts_per_day` | yes | only lower |
| `protected_paths` | yes | only add |
| `safe_workflows` | no | yes |
| `security_notice` | yes | yes |
| `agent`, `require_ruleset` | yes | no |

## Models

```yaml
models:
  allowed: [opencode-go/*]       # wildcards allowed; repositories cannot pick anything else
triage:
  model: opencode-go/muse-spark-1.3-contributor
```

Model names use OpenCode's `provider/model` form, with an optional `#variant`. Save the provider's key
in `/admin` under the variable OpenCode reads, such as `OPENCODE_API_KEY` for OpenCode Go.

## Routes

A cheap model with no tools reads each new issue and answers only with a kind and a size. The first
matching route decides what happens:

```yaml
routes:
  - when: { kind: [spam] }
    action: ignore
  - when: { kind: [security] }
    action: security-notice        # posts security_notice, asking for a private report
  - when: { kind: [question] }
    action: reply
    model: opencode-go/muse-spark-1.3-contributor
  - when: { kind: [bug], size: [large] }
    action: fix
    model: opencode-go/deepseek-v4.1-flash
  - when: { kind: [bug, feature, docs] }
    action: fix
    model: opencode-go/muse-spark-1.3-contributor
```

Kinds: `bug`, `feature`, `docs`, `question`, `spam`, `security`. Sizes: `small`, `medium`, `large`.
Actions: `fix`, `reply`, `ignore`, `security-notice`. An issue that matches no route is left alone.

## Reviews

```yaml
review:
  model: opencode-go/muse-spark-1.3-contributor
  checks: ["bun install --frozen-lockfile", "bun run typecheck", "bun test"]
  image: node:22-bookworm         # container image for checks
  on_push: true                   # follow-up reviews of new commits
  max_auto_reviews: 5             # after this, only `@tidy review` starts one
```

`checks` run on the pull request's code in a container without secrets, and the reviewer reads their
output. Pick commands that work offline and without credentials. The container has no `.git`, so a check
that compares against git history will fail there. For `extras`, see [Review extras](extras.md).

## Fixes from outside issues

```yaml
safe_workflows: [renovate-dist.yml]
```

When an issue thread includes text from people without write access, tidy reads the repository's
workflows. If any of them run on pull requests and use secrets, tidy posts the patch on the issue and
waits for `@tidy publish` instead of pushing (see [How it works](how-it-works.md#fixes-from-outside-issues)).
List workflows here that use secrets only on branches tidy never pushes, such as one limited to
`renovate/` branches.

## Limits and protection

```yaml
limits:
  outsider_attempts_per_day: 2    # issues and pull requests per person without write access
protected_paths:                  # patches touching these are rejected
  - .github/
  - opencode.json
require_ruleset: false            # true: refuse to push where the default branch needs no approval
```

A trailing slash in `protected_paths` means a directory at the repository root; a bare name matches
that file anywhere.

## Agent

```yaml
agent:
  opencode: 2.2.7                 # exact OpenCode version installed in the agent container
  image: node:22-bookworm
  timeout_minutes: 30
```
