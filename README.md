# arra-oracle-discord

Our own Discord channel for Claude Code — a fork of
[`claude-plugins-official/discord`](https://github.com/anthropics/claude-plugins-official)
(0.0.4), made self-contained in this repo (like `mqtt-channel/`) and extended
**Hermes-style** with two capabilities the upstream plugin lacks:

| tool | what it adds |
|------|--------------|
| `create_thread` | Start a Discord thread (Hermes `auto_thread`). Returns the thread id — pass it as `chat_id` to talk inside the thread. |
| `reply` (extended) | `mention_users` / `mention_roles` → **@-tag** people. `allowed_mentions` is scoped to exactly those ids, so stray `@`-text never pings anyone unintended. |

Everything else is upstream: `reply`, `react`, `edit_message`, `download_attachment`,
`fetch_messages`, pairing/allowlist gate, thread→parent resolution, and the
chaiklang (Yutthakit) group-key footgun guard (see `patches/`).

## Tools

- **reply** `{ chat_id, text, reply_to?, files?, mention_users?, mention_roles? }`
- **create_thread** `{ chat_id, name, message_id?, message?, auto_archive_minutes? }`
  - `message_id` → thread hangs off that message; otherwise a standalone thread on the channel.
  - `message` → optional opening post inside the new thread.
  - returns `thread created (id: <id>) — reply with chat_id=<id>`.
- **react** `{ chat_id, message_id, emoji }`
- **edit_message** `{ chat_id, message_id, text }`
- **download_attachment** `{ chat_id, message_id }`
- **fetch_messages** `{ channel, limit? }`

## Run it as a channel

Bound via the **root `.mcp.json`** (server name `arra-oracle-discord`) — this is what
makes Claude Code route inbound notifications as channel messages. `--cwd` alone
(`--plugin-dir`) gives a different identity that is NOT bound as a channel.

```bash
# env (loaded by repo .envrc via direnv): DISCORD_STATE_DIR=$PWD/.discord,
# DISCORD_BOT_TOKEN=$(pass show discord/nh-oracle-token)
claude --dangerously-load-development-channels server:mqtt server:arra-oracle-discord
```

## Config / access

- State dir: `$DISCORD_STATE_DIR` (repo → `.discord/`). Token in `.discord/.env` or env.
- Access is managed by `.discord/access-ctl.ts` — **never hand-edit `access.json`**.
  A channel must be allowlisted (`access-ctl group add <channelId>`) before the bot
  will send there; threads inherit their parent channel's allowlist.

## Provenance & patch stack

Fork base: `claude-plugins-official/discord` 0.0.4 · identity renamed to
`arra-oracle-discord` so it never clashes with the upstream plugin. Bundled
upstream skills were removed (access is our `access-ctl.ts`).

Our whole delta lives as reviewable diffs in `patches/`, applied in order on
pristine upstream `server.ts`:

1. `patches/001-discord-access-group-key-validation.patch` — chaiklang (Yutthakit)
   group-key footgun guard (upstream PR#2807, closed)
2. `patches/002-arra-oracle-discord-fork.patch` — this fork: identity, tagging
   (`mention_users`/`mention_roles` + scoped `allowed_mentions`), `create_thread`,
   `toArchiveDuration` helper, instructions

Numeric prefixes are the apply order: `for p in patches/[0-9]*.patch; do git apply "$p"; done`

Round-trip verified: upstream + both patches == `server.ts` here, byte-identical.
When upstream ships a new version, re-apply the stack (`git apply`) and regenerate
patch 2 from the resolved result.
