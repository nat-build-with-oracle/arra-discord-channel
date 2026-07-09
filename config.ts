// config.ts — the ONE file you edit for arra-oracle-discord.
//
//   1. edit the `config` object below (all knobs in one place, typed + commented)
//   2. run:  bun .discord/access-ctl.ts sync
//   3. done — sync expands this into .discord/access.json (the file the server reads)
//
// Single source of truth: access.json is a GENERATED artifact — edit config.ts, not
// access.json. Type-safety is viem-style: `as const satisfies DiscordConfig` means a
// bad snowflake or an unknown key fails `tsc` right here, and contact NAMES become a
// literal union you reference everywhere (autocomplete + typo-reject at compile time).

export type Snowflake = `${number}`

export type DiscordConfig = {
  /** name → Discord user id (snowflake). Reference people by name everywhere else. */
  contacts: Record<string, Snowflake>
  /** DM handling. 'allowlist' = bot ON (DMs limited to `answer`). 'disabled' = master OFF (drops everything). */
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  /** Channels the bot LISTENS in (ids). '*' = every channel the bot can see (broad — prefer explicit ids). */
  listen: (Snowflake | '*')[]
  /** Who the bot ANSWERS / acts on (contact names or ids). [] = act on everyone delivered. */
  answer: string[]
  /** false = hear every message in the listen channels; true = only when @-mentioned. */
  requireMention: boolean
  /** Hermes-style: when @-mentioned in a channel, open a thread and reply inside it. */
  autoThread: boolean
}

// ─────────────────────────── EDIT ME ───────────────────────────
export const config = {
  contacts: {
    nat: '691531480689541170',
  },
  dmPolicy: 'allowlist',
  listen: ['1501947835245924525'], // #learning-room
  answer: ['nat'],
  requireMention: false,
  autoThread: true,
} as const satisfies DiscordConfig
// ────────────────────────────────────────────────────────────────

// ---- derived helpers (don't edit) ----
export type ContactName = keyof typeof config.contacts
const BY_NAME: Record<string, string> = config.contacts

/** alias/name → snowflake, or pass a raw id straight through. */
export const resolveContact = (ref: string): string => BY_NAME[ref] ?? ref
/** snowflake → contact name (for readable meta/logs), or undefined. */
export const nameFor = (id: string): ContactName | undefined =>
  (Object.entries(config.contacts) as [ContactName, Snowflake][]).find(([, v]) => v === id)?.[0]
/** is `ref` a name we know? (access-ctl validates config against this at write time.) */
export const isKnownName = (ref: string): ref is ContactName => ref in config.contacts
