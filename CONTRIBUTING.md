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

Run the Python worker and relay tests with Python 3.12+. They use the standard library and fake guest transports, so they need no runtime installation. The relay test needs local loopback sockets:

```sh
python3 -B -m unittest discover -s runtime -p 'test_*.py'
```

CI runs the TypeScript and Python suites, including browser tests.

## Where tests belong

Keep tests beside others for the behavior they protect: configuration in `config.test.ts`, frozen context in `prepare.test.ts`, adapter preparation in `adapters.test.ts`, and run lifecycle in `runner.test.ts`. Archive, reporting, scoring, capture, and state each have their own suites.

The dashboard tests are split into results/navigation (`dashboard.test.ts`), viewer/security (`dashboard-viewer.test.ts`), and appearance (`dashboard-appearance.test.ts`). `ui.test.ts` tests the HTTP server; `store.test.ts` tests archive discovery and deletion.

`test/support/` holds shared fixtures. Use `tempDirectory(t)` and `setEnvironment(t, values)` so cleanup runs even when assertions fail. Register server and broker cleanup as soon as they are created. Keep scenario-specific inputs and expected values in the test; browser tests should wait for observable state and fix the clock when asserting dates.

To run one suite after building:

```sh
CRUCIBLE_CONFIG=/dev/null node --test dist/test/adapters.test.js
```

## Working on the dashboard

```sh
npm run dev:ui       # the dashboard with hot reload, against `crucible ui` on CRUCIBLE_UI_PORT (default 8300)
```

Run `crucible ui` in another terminal so the dev server has data to show. `ui/DESIGN.md` describes the dashboard's pages, states, and design decisions.

## Pull requests

Keep changes small and focused, and make sure `npm run check`, `npm run build`, and `npm test` pass. If you change the experiment format, update `docs/experiments.md` and `example.yaml` in the same change.
