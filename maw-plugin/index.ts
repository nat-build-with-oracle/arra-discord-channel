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

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
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

// --- install: wire both channels into an oracle repo (idempotent + clobber-safe) ---
const DISCORD_REPO = "https://github.com/nat-build-with-oracle/arra-discord-channel.git";
const MQTT_REPO = "https://github.com/nat-build-with-oracle/arra-mqtt-channel.git";

// Run a command in a scoped env; env is REPLACED per key we pass (never leak the caller's
// DISCORD_STATE_DIR — that leak is exactly what clobbered a sibling oracle's access.json).
async function sh(log: Log, cmd: string[], env: Record<string, string> = {}, cwd?: string): Promise<boolean> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd, env: { ...process.env, ...env } });
  const out = (await new Response(p.stdout).text()).trim();
  const err = (await new Response(p.stderr).text()).trim();
  const code = await p.exited;
  if (out) log("  " + out.replace(/\n/g, "\n  "));
  if (code !== 0 && err) log("  ! " + err.split("\n")[0]);
  return code === 0;
}
const gitRoot = (dir: string): string => {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe" });
    const s = new TextDecoder().decode(p.stdout).trim();
    return s || dir;
  } catch { return dir; }
};

const commands: Record<string, (log: Log, args: string[]) => Promise<void>> = {
  // install — wire the mqtt + arra-oracle-discord channels into an oracle repo, in one shot.
  //   maw arra-discord install [<target-repo>] [--prefix <name>] [--branch main]
  // Idempotent (every step skips if already done) and clobber-SAFE (state writes pin
  // DISCORD_STATE_DIR/MQTT_STATE_DIR to the TARGET inline; access.json is NEVER re-init'd
  // if it exists — a leaked env or a repeat run must not wipe another oracle's allowlist).
  async install(log, a) {
    const rest = a.slice(1);
    const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
    const positional = rest.filter((x, i) => !x.startsWith("--") && rest[i - 1] !== "--prefix" && rest[i - 1] !== "--branch");
    const explicit = positional[0];
    // A state-mutating command must NOT guess its target from ambient $PWD when run
    // non-interactively (cron/dispatch) — a stale PWD would wire the WRONG oracle.
    if (!explicit && !process.stdout.isTTY) {
      log("refusing to guess a target with no TTY — pass one: maw arra-discord install <oracle-repo>");
      return;
    }
    // maw runs this plugin with cwd = plugin dir, so interactively default to the SHELL cwd.
    const target = gitRoot(resolve(explicit ?? process.env.PWD ?? process.cwd()));
    const branch = opt("--branch") ?? "main";
    const prefix = (opt("--prefix") ?? basename(target).replace(/-oracle$/, "")).toLowerCase();
    const rp = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

    // Refuse the channel repo itself — by identity (realpath) or its root fingerprint
    // (access-ctl.ts + access.schema.json live at the channel repo root, never in an oracle).
    if (rp(target) === rp(CHANNEL_ROOT) || (existsSync(join(target, "access-ctl.ts")) && existsSync(join(target, "access.schema.json")))) {
      log(`refusing: ${target} is the channel repo itself — pass an oracle repo`);
      return;
    }
    // Positive oracle marker (not the old "has a maw-plugin" heuristic, which false-refused
    // real oracles that register their own maw commands).
    const looksLikeOracle = /-oracle$/.test(basename(target)) || existsSync(join(target, "CLAUDE.md")) || existsSync(join(target, "ψ"));
    if (!looksLikeOracle) {
      log(`refusing: ${target} doesn't look like an oracle repo (no *-oracle name / CLAUDE.md / ψ). pass the right target.`);
      return;
    }
    const discordDir = join(target, ".discord");
    const scoped = { DISCORD_STATE_DIR: discordDir, MQTT_STATE_DIR: join(target, "mqtt-channel") };
    log(`🚌 install channels → ${target}   (mqtt prefix: ${prefix})`);

    // 0) read/validate the existing .mcp.json FIRST (fail-safe) — a malformed file must not
    // throw AFTER submodules are added and leave the repo half-wired.
    const mcpFile = join(target, ".mcp.json");
    let mcp: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpFile)) {
      try { mcp = JSON.parse(readFileSync(mcpFile, "utf8")); }
      catch { const bak = mcpFile + ".bak"; writeFileSync(bak, readFileSync(mcpFile)); log(`  ! .mcp.json malformed → backed up to ${basename(bak)}, starting fresh`); mcp = {}; }
    }

    // 1) submodules. Guard on git's OWN state, not just the worktree file — a stale
    // .gitmodules/.git/modules entry (from a partial run) makes `add` fail; re-materialize
    // with `update --init`. Verify server.ts landed; ABORT (no success banner) if not.
    for (const [path, url] of [["arra-oracle-discord", DISCORD_REPO], ["mqtt-channel", MQTT_REPO]] as const) {
      if (existsSync(join(target, path, "server.ts"))) { log(`  ✓ ${path} present`); continue; }
      const known = (existsSync(join(target, ".gitmodules")) && readFileSync(join(target, ".gitmodules"), "utf8").includes(`path = ${path}`)) || existsSync(join(target, ".git", "modules", path));
      log(`  + ${path}…`);
      const ok = known
        ? await sh(log, ["git", "-C", target, "submodule", "update", "--init", "--", path])
        : await sh(log, ["git", "-C", target, "submodule", "add", "-b", branch, url, path]);
      if (!ok || !existsSync(join(target, path, "server.ts"))) {
        log(`  ✗ ${path} not materialized — clear its stale .gitmodules / .git/modules/${path} entry, then re-run`);
        log("");
        log("⛔ install aborted — channels NOT wired.");
        return;
      }
    }

    // 2) root .mcp.json — merge the two servers (never clobber other mcpServers)
    mcp.mcpServers ??= {};
    const before = JSON.stringify(mcp.mcpServers);
    mcp.mcpServers.mqtt ??= { command: "bun", args: ["run", "--cwd", "mqtt-channel", "--shell=bun", "--silent", "start"] };
    mcp.mcpServers["arra-oracle-discord"] ??= { command: "bun", args: ["run", "--cwd", "arra-oracle-discord", "--shell=bun", "--silent", "start"] };
    if (JSON.stringify(mcp.mcpServers) !== before) { writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n"); log("  + .mcp.json (mqtt + arra-oracle-discord)"); }
    else log("  ✓ .mcp.json already has both servers");

    // 3) .envrc — append the channel env block ONCE. Guard on the real export line (not a
    // comment) so a differently-worded prior setup still counts as "already wired".
    // Token source: if `pass show discord/<prefix>-oracle-token` resolves (the fleet
    // convention), wire it LIVE; otherwise leave it commented for the operator to fill in.
    // Override with --pass <path> or --no-pass.
    const envrc = join(target, ".envrc");
    const MARK = 'DISCORD_STATE_DIR="$PWD/.discord"';
    const noPass = rest.includes("--no-pass");
    const passPath = opt("--pass") ?? `discord/${prefix}-oracle-token`;
    const passOk = !noPass && (await sh(() => {}, ["pass", "show", passPath]));
    const tokenLine = passOk
      ? `export DISCORD_BOT_TOKEN="$(pass show ${passPath})"`
      : `#export DISCORD_BOT_TOKEN="$(pass show ${passPath})"   # ← set this, or write .discord/.env`;
    if (!(existsSync(envrc) ? readFileSync(envrc, "utf8") : "").includes(MARK)) {
      appendFileSync(envrc, `\n# ── Channels: mqtt + arra-oracle-discord — loaded via .mcp.json ──\nexport DISCORD_STATE_DIR="$PWD/.discord"\n${tokenLine}\nexport MQTT_STATE_DIR="$PWD/mqtt-channel"\ndotenv_if_exists "$MQTT_STATE_DIR/.env"\n`);
      log(passOk ? `  + .envrc channel env — token from pass:${passPath} ✓  (run: direnv allow)` : "  + .envrc channel env  (token: set .discord/.env or a pass entry)");
    } else log(`  ✓ .envrc already wired${passOk ? ` (pass:${passPath} available)` : ""}`);

    // 4) mqtt-channel/.env — ALWAYS pin the per-oracle topic prefix. The channel repo ships
    // a committed .env (with another oracle's prefix), so "write if missing" would collide on
    // the shared bus — instead ensure MQTT_TOPIC_PREFIX == this oracle's, rewriting if needed.
    const mqttEnv = join(target, "mqtt-channel", ".env");
    if (existsSync(join(target, "mqtt-channel"))) {
      let envTxt = existsSync(mqttEnv) ? readFileSync(mqttEnv, "utf8") : "# mqtt-channel config (non-secret)\nMQTT_URL=mqtt://127.0.0.1:1883\n";
      const cur = envTxt.match(/^MQTT_TOPIC_PREFIX=(.*)$/m)?.[1]?.trim();
      if (cur === prefix) log(`  ✓ mqtt-channel/.env (prefix=${prefix})`);
      else {
        envTxt = /^MQTT_TOPIC_PREFIX=/m.test(envTxt)
          ? envTxt.replace(/^MQTT_TOPIC_PREFIX=.*$/m, `MQTT_TOPIC_PREFIX=${prefix}`)
          : envTxt.replace(/\n*$/, "\n") + `MQTT_TOPIC_PREFIX=${prefix}\n`;
        writeFileSync(mqttEnv, envTxt, { mode: 0o600 });
        log(cur ? `  ~ mqtt-channel/.env prefix ${cur} → ${prefix}` : `  + mqtt-channel/.env prefix=${prefix}`);
      }
    }

    // 5) deps (skip if node_modules already there)
    for (const ch of ["arra-oracle-discord", "mqtt-channel"]) {
      if (existsSync(join(target, ch, "package.json")) && !existsSync(join(target, ch, "node_modules"))) {
        log(`  + bun install (${ch})…`);
        await sh(log, ["bun", "install"], {}, join(target, ch));
      }
    }

    // 6) access.json — init ONLY if missing, DISCORD_STATE_DIR pinned to TARGET (never leak).
    // access-ctl init is an UNCONDITIONAL write(DEFAULT); re-running wipes allowlist+groups.
    mkdirSync(discordDir, { recursive: true, mode: 0o700 });
    const ctlFile = join(target, "arra-oracle-discord", "access-ctl.ts"); // canonical submodule copy
    if (existsSync(join(discordDir, "access.json"))) log("  ✓ access.json present — NOT touching (never re-init)");
    else if (existsSync(ctlFile)) { log("  + access.json (locked: dmPolicy=disabled)"); await sh(log, ["bun", ctlFile, "init"], scoped); }

    // 7) gitignore the bot token
    const gi = join(target, ".gitignore");
    if (!(existsSync(gi) ? readFileSync(gi, "utf8") : "").includes(".discord/.env")) {
      appendFileSync(gi, `\n# discord bot token (secret — never commit)\n.discord/.env\n.discord/approved/\n.discord/inbox/\n`);
      log("  + .gitignore .discord/.env");
    }

    log("");
    log("✅ channels wired. next:");
    log("   1) direnv allow");
    if (passOk) log(`   2) token: from pass ${passPath} ✓ (already wired) → maw arra-discord whoami  to verify`);
    else log(`   2) set the Discord token → pass insert ${passPath}  (then re-run install), or write ${discordDir}/.env`);
    log("   3) maw arra-discord access policy allowlist && maw arra-discord access group add '*' --observe");
    log("   4) claude --dangerously-load-development-channels server:mqtt server:arra-oracle-discord");
  },
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
  // resolve — one bare Discord snowflake → its real name. Channel first (the common case —
  // most unresolved ids seen in fleet traffic are channels/threads), falling back to a user
  // lookup. Same channel-then-user algorithm as nh-oracle's fleet-bus resolveDiscordName(),
  // but exposed here as a fleet-wide maw command so any oracle can resolve without needing
  // nh-oracle's HTTP server: `maw arra-discord resolve <id>`.
  async resolve(log, a) {
    const id = a[1];
    if (!id) throw new Error("usage: maw arra-discord resolve <id>");
    const c = await api(`/channels/${id}`);
    if (c.ok) {
      const kind = c.data.type === 1 ? "dm" : c.data.type === 3 ? "group-dm"
        : (c.data.type === 11 || c.data.type === 12) ? "thread" : "channel";
      const name = c.data.name ?? c.data.recipients?.[0]?.username ?? id;
      log(`${kind}: ${name}  (${id})`);
      return;
    }
    const chStatus = c.status;
    const u = await api(`/users/${id}`);
    if (u.ok) {
      log(`user: ${u.data.global_name ?? u.data.username}  (${id})`);
      return;
    }
    throw new Error(`not resolvable by this bot — channel HTTP ${chStatus}, user HTTP ${u.status} (id or permissions?)`);
  },
  // configure — status only here (never echo the token). Token WRITES go through the
  // Claude /arra-discord:configure skill (interactive, chmod 600) — headless token
  // injection is deliberately not a fleet command.
  async configure(log) {
    const env = join(STATE_DIR, ".env");
    // Token can come from the process env (which is how a pass-wired .envrc delivers it),
    // not only from $STATE_DIR/.env — report either source so pass users don't see "not set".
    const inEnv = !!process.env.DISCORD_BOT_TOKEN;
    const inFile = existsSync(env) && /^DISCORD_BOT_TOKEN=.+/m.test(readFileSync(env, "utf8"));
    log(`state dir : ${STATE_DIR}`);
    log(`token     : ${inEnv ? "SET (env / pass)" : inFile ? `SET (${env})` : `not set (env or ${env})`}`);
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
      log("  install [<repo>] [--prefix <name>]   wire mqtt + discord channels into an oracle repo");
      log("  access <args...> | configure | whoami | invite [admin|<perms>] | channels | resolve <id>");
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
