# Agent credentials

Every run starts one agent per arm and, unless the experiment sets `judge: none`, a judge. Each needs provider authentication. Crucible reads each supported login itself, on the host, outside the Linux guest, and gives the agent a random stand-in token instead. A small proxy inside Crucible (the credential broker) swaps the stand-in for the real login on the way to the provider, and only on that provider's API paths. The guest receives no real provider token or refresh token, and the host home and keychain are not mounted. Unsupported authentication flows are rejected, as described below.

`crucible start` checks each login before it launches anything, and `crucible doctor` runs the same checks without a run. If a login is missing it says which one and stops.

## Claude

Crucible uses a long-lived token stored in your macOS login keychain under the name `CLAUDE_CODE_OAUTH_TOKEN`. If you have exported `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`, it uses that instead, and an `ANTHROPIC_BASE_URL` you set becomes where the broker sends requests.

**Do not export the token in `~/.zshrc`.** A token session does not carry your organization or subscription details, so Claude Code quietly drops the newest models from your own sessions. Crucible already reads the token from the keychain.

Claude on Bedrock or Vertex (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) is not supported by the Harbor runtime because the credential broker does not handle those authentication flows. Use an Anthropic API key or Claude login instead.

## Codex

Crucible reads the login that `codex login` wrote to `~/.codex/auth.json`, or `OPENAI_API_KEY`. It reads the current access token on every request, so when your own Codex refreshes the login, runs pick that up. The agent's copy of `auth.json` holds only stand-ins, with no refresh token. If the access token would expire before an agent's timeout, `crucible start` says so: run any `codex` command to refresh it.

## Cursor

Crucible reads the login that `cursor-agent login` stored, from `~/.cursor/auth.json` or the keychain, the same way as Codex. The guest receives the same broker stand-in in its auth file and `CURSOR_AUTH_TOKEN`, which the Linux CLI uses to find its login. A `CURSOR_API_KEY` with no login is rejected because the broker does not handle that exchange. Sign in with `agent login` first.

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

**3. Check.**

```sh
crucible doctor
```

It checks provider logins and runtime prerequisites. Guest CLIs use those logins through the broker; your host home and keychain are not mounted into their Linux guests.

`claude setup-token` shows the token once and never again. If you are replacing a machine and would rather not create a new one, copy the keychain entry across with Keychain Access before you wipe the old one.
