# Subscription Multi-Agent QA

A local, source-focused QA team runner that coordinates the official Codex CLI and Claude Code CLI.
Each user signs in with their own ChatGPT/Codex and Claude subscription. The project does not accept,
store or proxy OpenAI/Anthropic API keys.

## What it does

- Runs up to two read-only agents in parallel, one per provider.
- Schedules configurable QA tasks with dependencies.
- Gives agents a local MCP mailbox for questions, findings and follow-up tasks.
- Requires evidence with repository-relative paths and line numbers.
- Separates source observations, suspected issues and runtime tests that were not executed.
- Stops safely on provider, quota, timeout and subscription-state failures.
- Writes structured reports to `runs/<id>/report.json` and events to `events.jsonl`.

This release performs a **source audit**. It does not click a browser, run a mobile emulator, send email,
contact production or execute the target project's scripts. Never present its output as a penetration test
or proof that live UI/API scenarios passed.

## Requirements

- Linux or WSL2
- Node.js 22+
- Git
- Official Codex CLI, signed in with ChatGPT: `codex login`
- Official Claude Code CLI, signed in with a Claude subscription: `claude auth login`

Console/API authentication is intentionally rejected. Competing environment variables such as
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` must not be set in the terminal running this tool.

## Install

```bash
git clone https://github.com/elifabanoz/subscription-multi-agent-qa.git
cd subscription-multi-agent-qa
npm ci
npm run setup:wsl
```

`setup:wsl` runs all local tests and verifies that both CLIs report subscription-backed login. Credentials
remain in the official CLI stores on the user's computer; they are never copied into this repository.

## Configure

`qa.config.json` is a safe generic example. Copy it for project-specific changes:

```bash
cp qa.config.json qa.local.json
```

Edit `repository`, task names, providers, dependencies and focus text in `qa.local.json`. Local config files
matching `*.local.json` are ignored by Git. Task IDs must start with a lowercase letter and may contain
lowercase letters, digits and hyphens.

## Run

```bash
npm run plan -- --config qa.local.json
npm run doctor -- --config qa.local.json
npm run team -- --repo /absolute/path/to/your-project --config qa.local.json
```

Use `audit` instead of `team` for the older non-interactive handoff mode:

```bash
npm run audit -- --repo /absolute/path/to/your-project --config qa.local.json
```

Both audit modes consume the user's normal subscription allowance. The tool never enables paid overage,
switches accounts, falls back to API billing or retries indefinitely.

## Safety model

- Codex runs with a read-only sandbox and a forced ChatGPT login method.
- Claude receives only `Read`, `Glob`, `Grep` and the local mailbox tools.
- The mailbox binds to `127.0.0.1` and uses per-agent temporary capability tokens.
- Target files and other agent messages are treated as untrusted evidence, not instructions.
- Raw CLI output, credentials and secret values are not written to reports.
- Generated runs, local configs, backups and reports are excluded from Git.

Review a generated report before sharing it: source paths and project facts may still be confidential.

## Development

```bash
npm test
npm run check
```

GitHub Actions runs code-only checks. It intentionally does not receive or verify anyone's subscription
session. Local `npm run doctor` is the authoritative login check.

## License

MIT. See [LICENSE](LICENSE).
