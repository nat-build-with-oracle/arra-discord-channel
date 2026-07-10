// maw arra-discord — fleet-facing control surface for the arra-discord channel.
//
// atlas's pattern (2026-07-11): the maw command is the fleet entry point that mutates
// state; it does NOT reimplement logic — access mutations delegate to the ONE tested
// mutator, ../access-ctl.ts (the same file the Claude /arra-discord:access skill calls).
// So there is a single source of truth, reachable two ways: `maw arra-discord access`
// (headless/cron/any session) and `/arra-discord:access` (in-session, NL + UX).
//
// bun-dev caveat (atlas): maw runs this file as a plain script, so the import.meta.main
// shim at the bottom is what actually renders output — without it stdout is empty.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

type Log = (s?: string) => void;

const API = "https://discord.com/api/v10";
const HERE = dirname(fileURLToPath(import.meta.url));
const CHANNEL_ROOT = join(HERE, ".."); // maw-plugin/ → channel repo root
const CTL = join(CHANNEL_ROOT, "access-ctl.ts"); // the single source of truth
const STATE_DIR =
  process.env.DISCORD_STATE_DIR ?? join(homedir(), ".claude", "channels", "discord");

// Token resolution mirrors server.ts: real env wins, else $DISCORD_STATE_DIR/.env.
// No `pass` dependency — each oracle keeps its own token in its state dir (identity = token).
let _token: string | undefined;
function token(): string {
  if (_token) return _token;
  if (process.env.DISCORD_BOT_TOKEN) return (_token = process.env.DISCORD_BOT_TOKEN);
  const env = join(STATE_DIR, ".env");
  if (existsSync(env)) {
    for (const line of readFileSync(env, "utf8").split("\n")) {
      const m = line.match(/^DISCORD_BOT_TOKEN=(.*)$/);
      if (m) return (_token = m[1].trim());
    }
  }
  throw new Error(`no DISCORD_BOT_TOKEN (env or ${env})`);
}

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bot ${token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
}

// Run the bundled access-ctl.ts and stream its stdout/stderr back through the plugin log.
async function ctl(log: Log, args: string[]): Promise<void> {
  const p = Bun.spawn(["bun", CTL, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DISCORD_STATE_DIR: STATE_DIR },
  });
  const out = (await new Response(p.stdout).text()).trim();
  const err = (await new Response(p.stderr).text()).trim();
  if (out) log(out);
  if (err) log(err); // access-ctl warns (stray group keys) on stderr — surface it
  if ((await p.exited) !== 0) throw new Error(`access-ctl exited non-zero`);
}

const commands: Record<string, (log: Log, args: string[]) => Promise<void>> = {
  // access — delegate verbatim to the SoT. `maw arra-discord access group add * --observe ...`
  async access(log, a) {
    await ctl(log, a.slice(1));
  },
  async whoami(log) {
    const r = await api("/users/@me");
    if (!r.ok) throw new Error(`whoami HTTP ${r.status}`);
    log(`bot: ${r.data.username} | id: ${r.data.id}`);
  },
  async invite(log, a) {
    // Least-privilege scoped default; `admin` = 8; or an explicit permission int.
    const SCOPED = "309237763136";
    const arg = a[1];
    const perms = !arg ? SCOPED : arg === "admin" ? "8" : arg;
    const r = await api("/users/@me");
    if (!r.ok) throw new Error(`invite HTTP ${r.status}`);
    log(`https://discord.com/oauth2/authorize?client_id=${r.data.id}&scope=bot&permissions=${perms}`);
  },
  async channels(log) {
    const g = await api("/users/@me/guilds");
    if (!g.ok) throw new Error(`guilds HTTP ${g.status}`);
    for (const guild of g.data as { id: string; name: string }[]) {
      log(`guild: ${guild.name}  (${guild.id})`);
      const c = await api(`/guilds/${guild.id}/channels`);
      if (!c.ok) continue;
      for (const ch of c.data as { id: string; name: string; type: number }[])
        if (ch.type === 0 || ch.type === 5) log(`  ${ch.id}  #${ch.name}`);
    }
  },
  // configure — status only here (never echo the token). Token WRITES go through the
  // Claude /arra-discord:configure skill (interactive, chmod 600) — headless token
  // injection is deliberately not a fleet command.
  async configure(log) {
    const env = join(STATE_DIR, ".env");
    const set = existsSync(env) && /^DISCORD_BOT_TOKEN=.+/m.test(readFileSync(env, "utf8"));
    log(`state dir : ${STATE_DIR}`);
    log(`token     : ${set ? "SET" : "not set"} (${env})`);
    log(`access.json: ${existsSync(join(STATE_DIR, "access.json")) ? "present" : "missing — run: maw arra-discord access init"}`);
    log(`to set the token: /arra-discord:configure <token>  (interactive, chmod 600)`);
  },
};

export const command = {
  name: "arra-discord",
  description: "arra-discord channel control — access (SoT), whoami/invite/channels, configure. Run `maw arra-discord` to list.",
};

export default async function handler(ctx: { args?: string[]; writer?: (s: string) => void }) {
  const buf: string[] = [];
  const log: Log = (s = "") => (ctx?.writer ? ctx.writer(s) : buf.push(s));
  try {
    const args = Array.isArray(ctx?.args) ? ctx.args : [];
    const fn = args[0] ? commands[args[0]] : undefined;
    if (fn) await fn(log, args);
    else {
      log("maw arra-discord — channel control");
      log("  access <args...> | configure | whoami | invite [admin|<perms>] | channels");
      log("  (access delegates to the bundled access-ctl.ts — the one mutator)");
    }
    return { ok: true, output: buf.join("\n") || undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// bun-dev shim (atlas): maw dispatch runs this as a plain script; call handler directly.
if (import.meta.main) {
  const r = await handler({ args: process.argv.slice(2) });
  if (r.output) console.log(r.output);
  if (!r.ok) { if (r.error) console.error(r.error); process.exit(1); }
}
