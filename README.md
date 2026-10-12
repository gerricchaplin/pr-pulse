# PR Pulse

[![CI](https://github.com/gerricchaplin/pr-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/gerricchaplin/pr-pulse/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gerricchaplin/pr-pulse/actions/workflows/codeql.yml/badge.svg)](https://github.com/gerricchaplin/pr-pulse/actions/workflows/codeql.yml)
[![Security](https://github.com/gerricchaplin/pr-pulse/actions/workflows/security.yml/badge.svg)](https://github.com/gerricchaplin/pr-pulse/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/gerricchaplin/pr-pulse/badge)](https://scorecard.dev/viewer/?uri=github.com/gerricchaplin/pr-pulse)
[![License: MIT](https://img.shields.io/badge/license-MIT-6000F0.svg)](LICENSE)

Live GitHub pull-request status inside [Claude Code](https://claude.com/claude-code): checks, merge readiness, review comments, your review queue and change alerts, without leaving the terminal.

![PR Pulse pane watching a pull request: merge-readiness verdict, check progress, recent activity and workflows](assets/pr-pulse.png)

## Install

```text
/plugin marketplace add gerricchaplin/pr-pulse
/plugin install pr-pulse@pr-pulse
```

Requires the [GitHub CLI](https://cli.github.com) (`gh`), signed in (`gh auth status`). PR Pulse makes every GitHub call through `gh`, as you.

## Use

Run `/pulse` in a GitHub repo. Optional argument: `owner/repo`, `owner/repo#123` or a PR URL.

PR Pulse opens in the same window as your Claude conversation, as three tabbed panes, so you can keep working with Claude while it watches.

| Pane | Shows |
|---|---|
| **PR Pulse** | Your open PRs, a merge-readiness verdict, check progress and drill-down into failures |
| **PR history** | Your PRs and everyone's merged in the last 7 days |
| **PR reviews** | PRs waiting on you, and on your teams |

### Watch

- **Merge readiness**: a verdict (`✓ READY TO MERGE`, `✗ BLOCKED · n`, `◐ WAITING ON CHECKS`) with the checklist behind it.
- **Checks**: a progress bar, failed checks first, and drill-down from workflow to job to steps with a failure-log excerpt.
- **After merge**: once a PR merges, the runs on its merge commit (a deploy or apply, say) replace the PR's own checks.
- **Comments**: unresolved review threads, the conversation and resolved threads.
- **Alerts**: a toast and a recent-activity entry when a check fails or all pass, a review lands, someone comments, the PR becomes ready, or a review is requested from you.

### Act

- **Stale branches**: when a merge leaves your PR behind its base or in conflict, you get an alert and buttons beside the checklist.
  - **Merge main in** and **Rebase on main** update the branch on GitHub (`gh pr update-branch`; press twice to confirm).
  - **Rebase with Claude** drafts a prompt to rebase locally and resolve conflicts, asking before it force-pushes.
- **Re-run** (beside each failed check from GitHub Actions): retries only the failed jobs of that run with `gh run rerun --failed`, for flaky, timed-out or cancelled jobs (press twice to confirm). A real failure needs a fix, not a re-run.
- **Auto-merge**: **⚡ Auto-merge when checks pass** turns on GitHub's auto-merge for an open, non-draft PR (`gh pr merge --auto`, using the repo's allowed method, squash first); **✕ Cancel auto-merge** turns it off again. Both need a second press, and the button only shows when GitHub says you can use it.
- **Fix with Claude / Address with Claude**: drafts a prompt from a failed check's log or a review thread into your prompt box. Nothing is sent until you press Enter.

### Claude-aware

When Claude runs `gh pr create` or `git push`, PR Pulse follows that PR, as the band if it was not open. If a check then fails on it, a short note with the failure log is added to **your next prompt**, so Claude already knows. A one-line note follows when CI is green again. Every note shows in Recent activity first, and nothing is sent on its own.

### Keys and settings

| Key | Action |
|---|---|
| `r` | Refresh |
| `m` | Minimise to a one-line band above the prompt; polling and alerts carry on |
| `e` or `/pulse` | Expand the band again |
| `o` | Open the PR in the browser |
| `q` | Close |

Settings live in `/config`, under PR Pulse, and are both on by default:

- **Follow the PRs Claude opens** (`autoFollow`)
- **Tell Claude when CI fails** (`ciContext`)

## Security

PR Pulse has no dependencies and a deliberately small reach: it runs only `gh`, `git`, `uname` and `open`/`xdg-open` (for `https://` links), never writes files, never calls a model and never sends a prompt for you. It reads Claude's own `gh pr create` and `git push` commands, without changing or blocking them, and adds CI notes only to a prompt you send; both can be switched off. CI fails if that reach grows without review. Details, the checks this repository runs, and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## GitHub API use

A local plugin cannot receive webhooks, so PR Pulse polls, and keeps it cheap:

- **One request per refresh**: a single GraphQL call returns your open PRs and the selected PR's details; history and the review queue ride along once a minute. Only the behind-count is a separate call.
- **Adaptive interval**: every 15 s while checks run, every 60 s when nothing is running, every 120 s when minimised and idle. Errors back off to at most 5 minutes.
- Calls are serial and go through your own `gh` token, sharing its hourly limits with everything else you run.

## Try it on this repo

This repository doubles as a demo target. `scripts/demo.sh <scenario>` opens a throwaway draft PR in a known state:

| Scenario | What PR Pulse shows |
|---|---|
| `green` | all checks pass, the "✓ All checks passed" alert |
| `fail` | a failing build with its error log, and **Fix with Claude** |
| `slow` | a two-minute check: the pane goes from running to green |
| `flaky` | fails, then passes after `gh run rerun --failed` without a false alert |
| `skip` | a skipped optional check |
| `title` | the required `pr-title` check failing |

`scripts/demo.sh clean` closes them all.

## Develop

```sh
npm ci                                   # pinned Claude Code
npx claude plugin validate .
npx claude plugin test .
python3 scripts/check-capabilities.py    # fails if the plugin's reach changed
```

Guidance for contributors and coding agents: [AGENTS.md](AGENTS.md).

## License

MIT
