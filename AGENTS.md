# AGENTS.md

Guidance for AI coding agents working on PR Pulse, a Claude Code plugin (a "mod") that shows live GitHub PR status in panes and a band above the prompt.

## Layout

- `hooks/register.tsx`: the whole plugin. Hooks are registered in `register`; helpers that take `$` must be top-level functions (the engine rejects passing `$` to anything else).
- `hooks/register.test.ts`: tests, run by `claude plugin test`. GitHub is faked by `fakeGh`; mutate `world` between refreshes to simulate changes.
- `types/index.d.ts`: types and the `PluginState` contract. Every `$.state` key the module reads or writes must be declared here.
- `capabilities.txt`: every hook and `$` call, as `claude plugin validate` reports them.
- `.claude-plugin/plugin.json` and `marketplace.json`: the plugin and its one-plugin marketplace.

## Commands

```sh
npm ci                     # pinned Claude Code for local checks
npx claude plugin validate .
npx claude plugin test .
python3 scripts/check-capabilities.py
```

All three must pass before a PR. `claude plugin test` must exit 0 with no "file ran to its end" failure: mount drawings through the `mount` helper so they unmount when a test ends.

## Rules

- **Keep the reach small.** Only run `gh`, `git`, `uname`, `open`/`xdg-open`; only open `https://` URLs; never write files, call models or `$.prompt.submit`. If a change needs a new hook or `$` call, update `capabilities.txt` in the same PR and say why in the description.
- **Every GitHub call goes through `gh`**, serially. Mind the rate limits: fast data every 15 s, slow data every 60 s.
- **UI:** no bold text; colours come from the `theme` object (dark and light variants). Button labels go in the `label` prop, never as multiple children.
- **No `on` or `$` shadowing:** never name a local variable `on`.
- **Tests:** add or update a test for every behaviour change; cover terminal and desktop surfaces for UI.
- **Comments:** only for a non-obvious why, one line, lowercase.
- **Commits and PR titles:** Conventional Commits (`feat: …`, `fix: …`, `ci: …`); the `pr-title` check enforces it.
