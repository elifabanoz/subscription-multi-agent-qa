# Security policy

## Supported use

Run Subscription Multi-Agent QA only on a trusted developer machine under Linux or WSL2. The tool invokes
the official `codex exec` and `claude -p` commands and must not require provider API keys. `npm run doctor`
must confirm both local subscription sessions before an audit starts.

Browser and Android live modes must target isolated local or staging systems. Never allow a production
origin or attach a personal device containing real data. Browser navigation and network requests are restricted
to configured origins. Android actions are restricted to a configured ADB serial; startup targets the configured
package, but taps and back navigation can leave that app on the disposable test device.

## Sensitive data

- Never commit API keys, CLI auth stores, `.env` files or generated audit reports.
- `runs/`, `backups/`, local configuration and generated reports stay outside Git.
- GitHub Actions performs code-only checks and receives no subscription credentials.
- Reports do not retain raw CLI output or access tokens, but can contain confidential source paths and
  project facts. Review every report before sharing it.

## Reporting a vulnerability

Please report security issues privately to the repository owner instead of opening a public issue. Include
reproduction steps, the affected version and expected impact, but never include real credentials or personal data.
