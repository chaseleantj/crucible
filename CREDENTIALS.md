# Agent credentials

Every A/B run starts one producer per arm and, unless the experiment sets `judge: none`, a judge. Each needs to log in to its provider. Producers run inside a scrubbed environment with a fake home directory, so they cannot see your normal login — the runner has to hand them a credential deliberately. This page explains where each credential comes from and how to set them up on a new machine.

`crucible start` checks all of this before it launches anything, and `crucible doctor` runs the same checks without a run. If a credential is missing it says which one and stops, rather than letting the agent start and fail a second later with "not logged in".

## Claude

Claude producers authenticate with a long-lived token, stored in your macOS login keychain under the name `CLAUDE_CODE_OAUTH_TOKEN`. The runner reads it from the keychain when it needs it. Nothing else is required — no shell setup, no environment variable.

If you have already exported a Claude credential in your environment, the runner uses that instead and leaves the keychain alone.

**Do not export the token in `~/.zshrc`.** It is tempting, because it makes the token available everywhere, and that is exactly the problem. A token session does not carry your organization or subscription details. Claude Code then has no way to know which models your team plan entitles you to, and quietly drops the newest ones from the model picker. Exporting the token globally costs you model access in your own sessions and buys nothing — the runner already fetches it on its own.

## Codex

Codex uses whatever `codex login` wrote to `~/.codex/auth.json`. The runner copies that file into the producer's fake home. You can also set `OPENAI_API_KEY` instead.

## Cursor

Cursor works the same way: log in with `agent login` and the runner copies `~/.cursor/auth.json` across. Cursor also stores credentials in the keychain, which the runner reads as a fallback, and `CURSOR_API_KEY` works too.

## Setting up on a new machine

You only need the providers you actually plan to run. For Claude, do these in order — the order matters.

**1. Sign in, then create the token.**

```sh
claude auth login      # sign in with the account you want the usage billed to
claude setup-token
```

A token belongs to whoever was signed in when it was created, and that account is where the usage is drawn from. Signing in first is what guarantees your runs bill to the right place. You can check which account you are on with `claude auth status`.

**2. Store the token in the keychain.**

```sh
security add-generic-password -s CLAUDE_CODE_OAUTH_TOKEN -a "$USER" -W
```

The `-W` flag prompts for the value, so the token never appears in your shell history. The service name has to match exactly, because that is the name the runner looks up.

**3. Build and check.**

```sh
npm ci
npm run build
npm test
```

The tests do not touch your real keychain, so they pass on any machine, set up or not. To confirm the credentials themselves are right, run `crucible doctor` and read the check it prints.

`claude setup-token` shows the token once and never again. If you are replacing a machine and would rather not create a new one, copy the keychain entry across with Keychain Access before you wipe the old one.
