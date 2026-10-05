# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.

You should get a response within 7 days. Fixes are released as a new version and noted in the release notes.

## Supported versions

Only the latest release is supported.

## What PR Pulse can do on your machine

PR Pulse is a Claude Code plugin with no dependencies. Its reach is deliberately small, and CI holds it there:

- **Programs it runs:** `gh` (all GitHub access, as your own signed-in `gh` user), `git` (to find the repo you are in), `uname` and `open`/`xdg-open` (to open `https://` links in your browser). The tests fail if the plugin runs anything else or opens a non-`https` link.
- **Claude Code APIs it uses:** listed in [`capabilities.txt`](capabilities.txt). CI fails when that surface changes, so any new reach is visible in review.
- **Never:** writes files, reads credentials, calls a model, or sends a prompt on your behalf. "Fix with Claude" and "Address with Claude" only put a draft in your prompt box; nothing is sent until you press Enter.
- **Network:** none of its own. Every request goes through `gh` to GitHub's API.

## How this repository is checked

| Check | Tool |
|---|---|
| Static analysis | [CodeQL](https://codeql.github.com) (TypeScript and GitHub Actions), [Semgrep CE](https://semgrep.dev) |
| Workflow security | [zizmor](https://docs.zizmor.sh), [actionlint](https://github.com/rhysd/actionlint) |
| Secrets | GitHub secret scanning with push protection, [Gitleaks](https://gitleaks.io) over full history |
| Supply chain | [OpenSSF Scorecard](https://scorecard.dev), every action pinned to a commit SHA, Dependabot |
| Plugin reach | `scripts/check-capabilities.py` and the capability guard in the tests |
