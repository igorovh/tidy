# Development

```sh
bun install
bun run typecheck
bun test
```

## Layout

| Path | What it is |
| --- | --- |
| `worker/` | The Cloudflare Worker: webhooks, `/setup`, `/admin`, credentials and the Durable Object |
| `scripts/` | Code the workflows run: `gate.ts`, `agent.ts`, `checks.ts`, `publish.ts`, plus `deploy.ts` and `protect.ts` |
| `shared/` | Code both sides use, such as sealing credentials to a job's key |
| `prompts/` | Prompts for triage, fixes, replies, reviews and extra planning |
| `.github/workflows/` | `tidy.yml` and the reusable workflows it calls |
| `tests/` | Unit tests, run with `bun test` |

## Run the Worker locally

`wrangler dev` needs a master key in `.dev.vars`, which git ignores:

```sh
echo "TIDY_MASTER_KEY=$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))')" > .dev.vars
bunx wrangler dev
```

Webhooks and the OIDC exchange need a real GitHub App, so test those against a deployed Worker, for
example with [tidy-playground](https://github.com/igorovh/tidy-playground).

## Deploy

```sh
bun run deploy
```

The first deploy creates `TIDY_MASTER_KEY` and prints a one-time setup link. Later deploys keep the key
and the stored data. `bun run deploy -- --reset-key` makes a new key and makes stored data unreadable, so
use it only before the GitHub App exists.
