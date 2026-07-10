#!/usr/bin/env bun
/**
 * access-ctl — the ONLY sanctioned way to mutate access.json (never hand-edit).
 *
 * Mirrors the claude-plugins-official discord plugin's Access schema + the
 * /arra-discord:access skill semantics, but as a real, testable program. Atomic
 * writes (tmp+rename), read-before-write, 2-space JSON, chaiklang PR#2807
 * group-key guard.
 *
 * Bundled with the plugin — the /arra-discord:access skill calls THIS, so the
 * mutation logic lives in one tested place. Targets $DISCORD_STATE_DIR/access.json
 * (the same file server.ts reads), falling back to ~/.claude/channels/discord.
 *
 * Usage:
 *   access-ctl show
 *   access-ctl init [--policy pairing|allowlist|disabled]   # create/reset (locked default: disabled)
 *   access-ctl policy <pairing|allowlist|disabled>
 *   access-ctl group add <channelId> [--no-mention] [--observe] [--allow id,id]
 *       default            → requireMention:true   (answer only @-mentions; rest DROPPED)
 *       --no-mention       → requireMention:false  (answer every allowlisted message)
 *       --observe          → requireMention:"observe" (SEE everything as context, answer only @-mentions)
 *       omit --allow       → allowFrom:[] = everyone in that channel
 *   access-ctl group rm <channelId>
 *   access-ctl allow <add|rm> <userId>
 *   access-ctl pair <code>          # approve a pending pairing → allowFrom + write approved/<id>
 *   access-ctl deny <code>          # drop a pending pairing
 *   access-ctl set <ackReaction|replyToMode|textChunkLimit|chunkMode|mentionPatterns|autoThread> <value>
 *       e.g. access-ctl set autoThread true      # tag + "thread"/"/thread <name>" opens a thread
 *            access-ctl set ackReaction 👀       # read-receipt on every delivered message ("" disables)
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STATE_DIR =
  process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
// Editors validate access.json against this schema (autocomplete + inline type errors).
// A raw URL resolves everywhere the plugin is installed (a relative path would dangle
// once access.json lives in a state dir separate from the plugin cache).
const SCHEMA_REF =
  'https://raw.githubusercontent.com/nat-build-with-oracle/arra-discord-channel/main/access.schema.json'

type Group = { requireMention: boolean | 'observe'; allowFrom: string[] }
type Pending = { senderId: string; chatId?: string; createdAt?: number; expiresAt?: number }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, Group>
  pending: Record<string, Pending>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  autoThread?: boolean
}

const DEFAULT = (policy: Access['dmPolicy'] = 'disabled'): Access => ({
  dmPolicy: policy, allowFrom: [], groups: {}, pending: {},
})

// chaiklang discord PR#2807 guard: groups only honor requireMention + allowFrom.
// mentionPatterns/ackReaction/replyToMode/autoThread are TOP-LEVEL — nesting them in a
// group silently does nothing. `group add` only writes the two valid keys, but a
// hand-edited file can stray, so warn on every read.
const GROUP_KEYS = new Set(['requireMention', 'allowFrom'])
function warnStrayGroupKeys(a: Access): void {
  for (const [chan, policy] of Object.entries(a.groups ?? {})) {
    for (const key of Object.keys((policy ?? {}) as Record<string, unknown>)) {
      if (!GROUP_KEYS.has(key)) {
        process.stderr.write(`access-ctl: access.json groups[${JSON.stringify(chan)}].${key} is ignored — groups only support requireMention and allowFrom; mentionPatterns/ackReaction/replyToMode/autoThread are top-level keys.\n`)
      }
    }
  }
}

function read(): Access {
  if (!existsSync(FILE)) return DEFAULT()
  const a = JSON.parse(readFileSync(FILE, 'utf8')) as Access
  delete (a as Record<string, unknown>).$schema // strip; write() re-adds a fresh ref
  warnStrayGroupKeys(a)
  return a
}
function write(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = FILE + '.tmp'
  const out = { $schema: SCHEMA_REF, ...a } // $schema first so editors pick it up
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, FILE)
}
function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true } return false
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v } return undefined
}

const [cmd, sub, ...rest] = process.argv.slice(2)
const args = [...rest]

switch (cmd) {
  case 'show': {
    console.log(JSON.stringify(read(), null, 2))
    break
  }
  case 'init': {
    // `--policy` lands in `sub` when it's the first token after init, so search the
    // combined list — otherwise `init --policy allowlist` silently kept disabled.
    const initArgs = [sub, ...args].filter((x): x is string => !!x)
    const policy = (opt(initArgs, '--policy') as Access['dmPolicy']) ?? 'disabled'
    write(DEFAULT(policy))
    console.log(`init → ${FILE} (dmPolicy=${policy}, locked)`)
    break
  }
  case 'policy': {
    if (!['pairing', 'allowlist', 'disabled'].includes(sub)) throw new Error('policy must be pairing|allowlist|disabled')
    const a = read(); a.dmPolicy = sub as Access['dmPolicy']; write(a)
    console.log(`dmPolicy = ${sub}`)
    break
  }
  case 'group': {
    const a = read()
    if (sub === 'add') {
      const chan = args[0]; if (!chan) throw new Error('group add <channelId> [--no-mention|--observe] [--allow id,id]')
      const noMention = flag(args, '--no-mention')
      const observe = flag(args, '--observe')
      const allowRaw = opt(args, '--allow')
      const requireMention: Group['requireMention'] = observe ? 'observe' : !noMention
      a.groups[chan] = {
        requireMention,
        allowFrom: allowRaw ? allowRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
      }
      write(a)
      console.log(`group add ${chan} → requireMention=${requireMention}, allowFrom=${a.groups[chan].allowFrom.length ? a.groups[chan].allowFrom.join(',') : '(everyone)'}`)
    } else if (sub === 'rm') {
      const chan = args[0]; delete a.groups[chan]; write(a)
      console.log(`group rm ${chan}`)
    } else throw new Error('group <add|rm>')
    break
  }
  case 'allow': {
    const a = read(); const id = args[0]; if (!id) throw new Error('allow <add|rm> <userId>')
    if (sub === 'add') { if (!a.allowFrom.includes(id)) a.allowFrom.push(id) }
    else if (sub === 'rm') { a.allowFrom = a.allowFrom.filter(x => x !== id) }
    else throw new Error('allow <add|rm> <userId>')
    write(a); console.log(`allowFrom = [${a.allowFrom.join(', ')}]`)
    break
  }
  case 'pair': {
    // sub = the 6-char code. Never auto-pick when omitted — an attacker can seed one
    // pending entry by DMing the bot; "approve the pending one" is the injection shape.
    const code = sub
    if (!code) throw new Error('pair <code> — pass the exact code (do not auto-pick)')
    const a = read()
    const p = a.pending?.[code]
    if (!p) throw new Error(`no pending pairing for code ${code}`)
    if (p.expiresAt && p.expiresAt < Date.now()) { delete a.pending[code]; write(a); throw new Error(`code ${code} expired`) }
    if (!a.allowFrom.includes(p.senderId)) a.allowFrom.push(p.senderId)
    delete a.pending[code]
    write(a)
    if (p.chatId) {
      mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(join(APPROVED_DIR, p.senderId), p.chatId, { mode: 0o600 })
    }
    console.log(`paired → allowed ${p.senderId}`)
    break
  }
  case 'deny': {
    const code = sub; if (!code) throw new Error('deny <code>')
    const a = read(); delete a.pending?.[code]; write(a)
    console.log(`denied ${code}`)
    break
  }
  case 'set': {
    const key = sub, val = args[0]
    if (!key || val === undefined) throw new Error('set <key> <value>')
    const a = read() as Record<string, unknown>
    if (key === 'mentionPatterns') a[key] = JSON.parse(val)
    else if (key === 'textChunkLimit') a[key] = Number(val)
    else if (val === 'true' || val === 'false') a[key] = val === 'true'
    else a[key] = val
    write(a as unknown as Access); console.log(`${key} = ${val}`)
    break
  }
  default:
    console.error('usage: access-ctl <show|init|policy|group|allow|pair|deny|set> ...')
    process.exit(1)
}
