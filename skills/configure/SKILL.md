---
name: configure
description: Set up the arra-discord channel — save the bot token and review status. Use when the user pastes a Discord bot token, asks to configure the channel, asks "how do I set this up" or "who can reach me," or wants channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(bun *)
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /arra-discord:configure — Channel Setup

Saves the bot token to `$DISCORD_STATE_DIR/.env` (Local-only design — the token
lives in one gitignored file the channel reads directly, no `pass`/`direnv`
override to fight) and orients the user. `server.ts` reads the token once at
boot; access is read live.

`$DISCORD_STATE_DIR` = the channel's state dir (set by `start.sh` to the repo's
`.discord/`, else `~/.claude/channels/discord`). Resolve it before touching files.

Arguments passed: `$ARGUMENTS`

## No args — status + next step

1. **Token** — read `$DISCORD_STATE_DIR/.env` for `DISCORD_BOT_TOKEN`. Show
   set / not-set; if set, show only the first 6 chars masked. To confirm WHICH
   bot a token is, decode the client_id (no login):
   `echo <token> | cut -d. -f1 | base64 -D` → the bot's user id.
2. **Access** — `bun "${CLAUDE_PLUGIN_ROOT}/access-ctl.ts" show`. Summarize:
   dmPolicy (one line on what it means), allowFrom, each group's
   `requireMention` mode (mention-only / answer-all / **observe**), autoThread,
   pending count.
3. **What next** (pick by state):
   - No token → *"Create a bot at discord.com/developers → Bot → Reset Token,
     enable **Message Content Intent**, then `/arra-discord:configure <token>`."*
   - Token set, nobody allowed → *"Add yourself: `/arra-discord:access allow
     <your-id>` (Developer Mode → Copy User ID), then set a channel policy."*
   - Token set, allowlist populated → *"Ready. Invite the bot and message it."*

## `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). Discord bot tokens are long
   base64-ish strings, usually starting `MT`/`Nz`; from Dev Portal → Bot → Reset
   Token, shown once.
2. `mkdir -p "$DISCORD_STATE_DIR"`
3. Read existing `.env` if present; update/add the `DISCORD_BOT_TOKEN=` line,
   preserve other keys, **no quotes** around the value.
4. `chmod 600 "$DISCORD_STATE_DIR/.env"` — it's a credential.
5. **Never commit it, never echo it back, never paste the value into chat.** The
   `.env` must be gitignored.
6. Confirm, then show the no-args status. Note: **token changes need a channel
   restart** (`/mcp` → reconnect, or restart the session) — `/mcp` reconnect
   alone reuses the launch-time env, so a full restart is safest.

## `clear` — remove the token

Delete the `DISCORD_BOT_TOKEN=` line (or the file if it's the only line).

## Notes

- Access (`access.json`) is re-read on every inbound message — policy changes
  via `/arra-discord:access` are instant, no restart. Only the **token** needs a
  restart.
- One token = one gateway connection. Running the same token on two machines
  starts a reconnect war — give each host its own bot token.
