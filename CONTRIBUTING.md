# Contributing

Crucible runs agents in Linux guests through Harbor and Apple Container on Apple silicon Macs with macOS 26+. Provider credentials stay in the host broker. You need Node 24+; runtime setup also needs Python 3.12+.

## Set up and run the checks

```sh
npm ci
npm run check        # type-check the CLI and the tests
npm run build        # the CLI to dist/src, the dashboard to dist/ui
npm test             # rebuilds the CLI and the dashboard, then runs every test in test/
```

The tests do not start agent sessions, read your keychain, or read your `~/.config/crucible/config.yaml`. A few skip themselves when something is missing:

- the capture tests and the dashboard tests, which drive the built dashboard in a browser, skip when Playwright's Chromium is not installed (`npm run setup:browsers`; CI runs it);
- the Codex MCP test skips when the `codex` CLI is not on your PATH;
- tests that exercise a real Harbor guest require `npm run setup:runtime`; ordinary unit tests use fake transports and make no model calls.

After runtime setup, run the Python worker and relay tests with the installed environment. The relay test needs local loopback sockets:

```sh
~/.local/share/crucible/harbor/venv/bin/python -B -m unittest discover -s runtime -p 'test_*.py'
```

## Working on the dashboard

```sh
npm run dev:ui       # the dashboard with hot reload, against `crucible ui` on CRUCIBLE_UI_PORT (default 8300)
```

Run `crucible ui` in another terminal so the dev server has data to show. `ui/DESIGN.md` describes the dashboard's pages, states, and design decisions.

## Pull requests

Keep changes small and focused, and make sure `npm run check`, `npm run build`, and `npm test` pass. If you change the experiment format, update `docs/experiments.md` and `example.yaml` in the same change.
