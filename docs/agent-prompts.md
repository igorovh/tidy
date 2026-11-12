# Prompts for coding agents

Paste one of these into a coding agent such as OpenCode, Claude Code or Codex. They point the agent at
[`llms.txt`](../llms.txt), which lists this documentation.

## Set up tidy for a repository

Run this in the repository tidy should work in. Your tidy instance must already be installed there.

```text
Set up tidy for this repository. Read https://raw.githubusercontent.com/igorovh/tidy/main/llms.txt
and the configuration guide it links to.

Then create .github/tidy.yml:
- review.checks: the install, typecheck, build and test commands this repository already uses in its
  package scripts or CI. Only include commands that work offline and without secrets, and none that
  compare against git history, because the checks container has no .git.
- safe_workflows: only workflows that use secrets on pull requests but never on tidy/ branches.
- review.extras: only if the repository already has a script that records or screenshots its UI.

Keep the file short, with a comment above each choice. Open a pull request and explain in its
description why you chose each command.
```

## Install your own tidy

Run this anywhere you can use a terminal, with `git`, `gh` and `bun` installed.

```text
Help me install my own tidy GitHub bot. Read https://raw.githubusercontent.com/igorovh/tidy/main/llms.txt
and the setup guide it links to, then guide me through it step by step:

1. Create my copy with `gh repo create <name> --template igorovh/tidy --public --clone`, then run
   `bun install`.
2. Ask me to run `bunx wrangler login` myself, because it opens a browser.
3. Run `bun run deploy` and give me the setup link and the admin link it prints.
4. Tell me what to click: Create GitHub App on the setup page, install the App on the repositories I
   want (including my tidy copy), and save my model key in /admin.
5. Offer to run `bun run protect` so my default branches require an approved pull request.

Never ask me to paste keys or tokens into this chat.
```
