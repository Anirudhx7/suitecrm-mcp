#!/usr/bin/env node
/**
 * SuiteCRM MCP Gateway Admin CLI
 * Profiles: Redis HASH crm:profiles (field=sub, value=JSON)
 * Sessions: Redis STRING keys auth:session:<token>
 */

import { Command } from 'commander';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';

const execFileAsync = promisify(execFile);

const REDIS_URL     = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ENTITIES_FILE = process.env.ENTITIES_FILE || '/etc/suitecrm-mcp/entities.json';
const HOSTS_FILE    = process.env.CRM_HOSTS_FILE || '/etc/suitecrm-mcp/crm-hosts.json';

// ── colour helpers ────────────────────────────────────────────────────────────

const isTTY  = process.stdout.isTTY;
const GREEN  = isTTY ? '\x1b[32m' : '';
const RED    = isTTY ? '\x1b[31m' : '';
const YELLOW = isTTY ? '\x1b[33m' : '';
const CYAN   = isTTY ? '\x1b[36m' : '';
const BOLD   = isTTY ? '\x1b[1m'  : '';
const DIM    = isTTY ? '\x1b[2m'  : '';
const RESET  = isTTY ? '\x1b[0m'  : '';
const c = (text, ...codes) => codes.join('') + text + (codes.length ? RESET : '');

// ── file helpers (entities/hosts only) ───────────────────────────────────────

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.error(c(`Error reading ${path}: ${e.message}`, RED));
    process.exit(1);
  }
}

function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// ── Redis client ──────────────────────────────────────────────────────────────

const redis = new Redis(REDIS_URL, { lazyConnect: true, enableReadyCheck: false });
redis.on('error', () => {});

async function connect() {
  if (redis.status !== 'ready') {
    try { await redis.connect(); }
    catch (e) {
      console.error(c(`Error: cannot connect to Redis at ${REDIS_URL}: ${e.message}`, RED));
      process.exit(1);
    }
  }
}

async function disconnect() {
  try { await redis.quit(); } catch {}
}

async function* scanKeys(pattern) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (keys.length) yield keys;
  } while (cursor !== '0');
}

// ── Redis profile helpers (crm:profiles HASH) ────────────────────────────────

async function loadAllProfiles() {
  const raw = await redis.hgetall('crm:profiles') || {};
  const profiles = {};
  for (const [sub, val] of Object.entries(raw)) {
    try { profiles[sub] = JSON.parse(val); } catch {}
  }
  return profiles;
}

async function saveProfile(sub, profile) {
  await redis.hset('crm:profiles', sub, JSON.stringify(profile));
}

async function deleteProfile(sub) {
  await redis.hdel('crm:profiles', sub);
}

// ── Redis session helpers (auth:session:* STRING keys) ────────────────────────

async function loadAllSessions() {
  const sessions = {};
  for await (const batch of scanKeys('auth:session:*')) {
    for (const key of batch) {
      const tok  = key.slice('auth:session:'.length);
      const data = await redis.get(key);
      if (data) {
        try { sessions[tok] = JSON.parse(data); } catch {}
      }
    }
  }
  return sessions;
}

async function deleteSession(token) {
  await redis.del(`auth:session:${token}`);
}

// ── profile lookup helper ─────────────────────────────────────────────────────

function findSub(profiles, { sub, email } = {}) {
  if (sub)   return sub in profiles ? sub : null;
  if (email) {
    const needle = email.toLowerCase();
    for (const [s, p] of Object.entries(profiles)) {
      const e = (p.email || '').toLowerCase();
      if (e === needle || e.split('@')[0] === needle || s.toLowerCase() === needle) return s;
    }
  }
  return null;
}

// ── misc helpers ──────────────────────────────────────────────────────────────

function ts(ms) {
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch { return String(ms); }
}

function nowMs() { return Date.now(); }

function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    import('http').then(({ default: http }) => {
      const req = http.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve({ data: JSON.parse(body) }); }
          catch { resolve({ data: null, error: 'invalid JSON' }); }
        });
      });
      const timer = setTimeout(() => { req.destroy(); resolve({ data: null, error: 'timeout' }); }, timeoutMs);
      req.on('error', (e) => { clearTimeout(timer); resolve({ data: null, error: e.message }); });
      req.on('response', () => clearTimeout(timer));
    });
  });
}

async function fetchHealth(port, path) {
  return httpGetJson(`http://localhost:${port}${path}`);
}

// ── list ─────────────────────────────────────────────────────────────────────

async function cmdList(opts) {
  await connect();
  const profiles  = await loadAllProfiles();
  const sessions  = await loadAllSessions();
  const entities  = loadJson(ENTITIES_FILE);
  const now       = nowMs();

  const sessionsBySub = {};
  for (const [tok, s] of Object.entries(sessions)) {
    (sessionsBySub[s.sub] ||= []).push({ tok, ...s });
  }

  if (!Object.keys(profiles).length) {
    console.log(c('No user profiles found.', YELLOW));
    await disconnect(); return;
  }

  let items = Object.entries(profiles).sort((a, b) =>
    (a[1].email || a[0]).localeCompare(b[1].email || b[0]));

  if (opts.user) {
    const needle = opts.user.toLowerCase();
    items = items.filter(([sub, p]) =>
      (p.email || '').toLowerCase() === needle ||
      (p.email || '').toLowerCase().split('@')[0] === needle ||
      sub.toLowerCase() === needle);
    if (!items.length) {
      console.error(c(`User '${opts.user}' not found.`, RED));
      await disconnect(); process.exit(1);
    }
  }

  for (const [sub, p] of items) {
    const ents = p.entities || {};
    if (opts.entity && !(opts.entity in ents)) continue;

    const email = p.email || sub;
    const name  = p.name  || '';
    console.log(c(email, BOLD + CYAN));
    if (name && name !== email) console.log(`  name:     ${name}`);
    console.log(`  sub:      ${c(sub, DIM)}`);

    if (!Object.keys(ents).length) {
      console.log(`  entities: ${c('none', YELLOW)}`);
    } else {
      for (const [code, creds] of Object.entries(ents)) {
        if (opts.entity && code !== opts.entity) continue;
        const label   = entities[code]?.label || code;
        const rawPass = creds.pass || '';
        const passStr = opts.showPass ? rawPass : (rawPass ? rawPass.slice(0, 6) + '...' : '(none)');
        console.log(`  ${c(code, BOLD)} (${label})  crm_user=${creds.user}  pass=${passStr}`);
      }
    }

    const userSessions = (sessionsBySub[sub] || []).sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
    const active = userSessions.filter(s => (s.expiresAt || 0) > now);
    if (active.length) {
      console.log(`  sessions: ${c(String(active.length) + ' active', GREEN)}`);
      for (const s of active) console.log(`    ${s.tok.slice(0, 20)}...  expires ${ts(s.expiresAt)}`);
    } else {
      console.log(`  sessions: ${c('none', DIM)}`);
    }
    console.log();
  }
  await disconnect();
}

// ── add ──────────────────────────────────────────────────────────────────────

async function cmdAdd(opts) {
  await connect();
  const profiles = await loadAllProfiles();
  let sub = findSub(profiles, { sub: opts.sub, email: opts.email });

  if (!sub) {
    if (opts.email) {
      sub = `manual|${opts.email}`;
      console.log(c(`No existing profile found — creating: ${sub}`, YELLOW));
    } else {
      console.error(c('Error: --sub or --email required', RED));
      await disconnect(); process.exit(1);
    }
  }

  const profile = profiles[sub] || (() => {
    const email = opts.email || sub;
    console.log(c(`Created profile for ${email}`, GREEN));
    return { email, name: email, entities: {} };
  })();

  if (opts.email) { profile.email = opts.email; profile.name = opts.email; }

  if (opts.entity) {
    if (!opts.user || !opts.pass) {
      console.error(c('Error: --user and --pass are required when using --entity', RED));
      await disconnect(); process.exit(1);
    }
    profile.entities = profile.entities || {};
    profile.entities[opts.entity] = { user: opts.user, pass: opts.pass };
    console.log(c(`Set ${opts.entity} credentials for ${profile.email || sub}`, GREEN));
  }

  await saveProfile(sub, profile);
  await disconnect();
}

// ── remove ───────────────────────────────────────────────────────────────────

async function cmdRemove(opts) {
  await connect();
  const profiles = await loadAllProfiles();
  const sub = findSub(profiles, { sub: opts.sub, email: opts.email });

  if (!sub) {
    console.error(c('User not found', RED));
    await disconnect(); process.exit(1);
  }

  const email = profiles[sub]?.email || sub;

  if (opts.entity) {
    if (!(opts.entity in (profiles[sub].entities || {}))) {
      console.log(c(`${opts.entity} not found in profile for ${email}`, YELLOW));
      await disconnect(); return;
    }
    delete profiles[sub].entities[opts.entity];
    await saveProfile(sub, profiles[sub]);
    console.log(c(`Removed ${opts.entity} access for ${email}`, GREEN));
  } else {
    await deleteProfile(sub);
    console.log(c(`Removed profile for ${email}`, GREEN));
  }
  await disconnect();
}

// ── whoami ───────────────────────────────────────────────────────────────────

async function cmdWhoami(opts) {
  await connect();
  const profiles = await loadAllProfiles();
  const sessions = await loadAllSessions();
  const entities = loadJson(ENTITIES_FILE);
  const now      = nowMs();

  const sub = findSub(profiles, { sub: opts.sub, email: opts.email });
  if (!sub) {
    console.error(c('Error: --sub or --email required (and must match an existing profile)', RED));
    await disconnect(); process.exit(1);
  }

  const p = profiles[sub];
  console.log(c(p.email || sub, BOLD + CYAN));
  console.log(`  sub: ${c(sub, DIM)}`);
  console.log();

  const ents = p.entities || {};
  console.log(c('Entity access:', BOLD));
  if (!Object.keys(ents).length) {
    console.log(c('  none', YELLOW));
  } else {
    for (const [code, creds] of Object.entries(ents)) {
      const label = entities[code]?.label || code;
      console.log(`  ${c(code, BOLD)} (${label})  crm_user=${creds.user}`);
    }
  }

  console.log();
  const active = Object.entries(sessions)
    .filter(([, s]) => s.sub === sub && (s.expiresAt || 0) > now);
  console.log(c('Active sessions:', BOLD));
  if (!active.length) {
    console.log(c('  none', DIM));
  } else {
    for (const [tok, s] of active) {
      console.log(`  ${tok.slice(0, 20)}...  expires ${ts(s.expiresAt)}`);
    }
  }
  console.log();
  await disconnect();
}

// ── test ─────────────────────────────────────────────────────────────────────

function crmLogin(endpoint, user, password, verifyTls) {
  // lgtm [js/insufficient-password-hash]
  const md5pass  = createHash('md5').update(password).digest('hex');
  const restData = JSON.stringify({
    user_auth: { user_name: user, password: md5pass },
    application_name: 'mcp-admin',
    name_value_list: [],
  });
  const body = Buffer.from(new URLSearchParams({
    method: 'login', input_type: 'JSON', response_type: 'JSON', rest_data: restData,
  }).toString());

  return new Promise((resolve, reject) => {
    import('https').then(({ default: https }) => {
      const url = new URL(endpoint);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        rejectUnauthorized: verifyTls,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': body.length,
        },
      };
      const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 15000);
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.write(body);
      req.end();
    });
  });
}

async function cmdTest(opts) {
  await connect();
  const profiles = await loadAllProfiles();
  const entities = loadJson(ENTITIES_FILE);

  let targets;
  if (opts.sub || opts.email) {
    const sub = findSub(profiles, { sub: opts.sub, email: opts.email });
    if (!sub) { console.error(c('User not found', RED)); await disconnect(); process.exit(1); }
    targets = [[sub, profiles[sub]]];
  } else {
    targets = Object.entries(profiles);
  }

  let failed = 0;
  for (const [, p] of targets) {
    const email = p.email || '?';
    for (const [code, creds] of Object.entries(p.entities || {})) {
      if (opts.entity && code !== opts.entity) continue;
      const endpoint = entities[code]?.endpoint;
      if (!endpoint) {
        console.log(`  ${c(email, CYAN)}/${c(code, BOLD)}  ${c('no endpoint configured', YELLOW)}`);
        continue;
      }
      const label = entities[code]?.label || code;
      process.stdout.write(`  ${c(email, CYAN)}/${c(code, BOLD)} (${label})  ... `);
      try {
        const result = await crmLogin(endpoint, creds.user, creds.pass, opts.verifyTls);
        const sid = result?.id;
        if (sid && sid !== '0' && sid !== 0 && sid !== '') {
          console.log(c('OK', GREEN));
        } else {
          console.log(c(`FAIL  (CRM returned id=${JSON.stringify(sid)})`, RED));
          failed++;
        }
      } catch (e) {
        console.log(c(`ERROR  ${e.message}`, RED));
        failed++;
      }
    }
  }
  await disconnect();
  if (failed) process.exit(1);
}

// ── set-crm-host ─────────────────────────────────────────────────────────────

function _rlPrompt(rl, question, defaultVal = '') {
  return new Promise(resolve => {
    const hint = defaultVal ? ` [${defaultVal}]` : '';
    rl.question(`  ${question}${hint}: `, ans => resolve(ans.trim() || defaultVal));
  });
}

async function cmdSetCrmHost(opts) {
  const hosts   = loadJson(HOSTS_FILE);
  const existing = hosts[opts.entity];
  const hasFlags = opts.sshHost || opts.sshUser || opts.command || opts.sshKey;

  if (existing) {
    console.log(c(`\nCurrent crm-hosts entry for ${opts.entity}:`, CYAN));
    console.log(JSON.stringify(existing, null, 2));
  }

  if (hasFlags) {
    // Flags supplied — confirm before applying if entry already exists
    if (existing) {
      const rl  = createInterface({ input: process.stdin, output: process.stdout });
      const ans = await new Promise(resolve => rl.question('\n  Apply these updates? [y/N]: ', resolve));
      rl.close();
      if (!ans.trim().toLowerCase().startsWith('y')) {
        console.log(c('No changes made.', DIM));
        return;
      }
    }
    const entry = existing ? { ...existing } : {};
    if (opts.sshHost)  entry.ssh_host = opts.sshHost;
    if (opts.sshUser)  entry.ssh_user = opts.sshUser;
    if (opts.command)  entry.command  = opts.command;
    if (opts.sshKey)   entry.ssh_key  = opts.sshKey;
    hosts[opts.entity] = entry;
    saveJson(HOSTS_FILE, hosts);
    console.log(c(`\nUpdated crm-hosts entry for ${opts.entity}:`, GREEN));
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  // No flags — go interactive
  if (existing) {
    const rl  = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(resolve => rl.question('\n  Update these values? [y/N]: ', resolve));
    if (!ans.trim().toLowerCase().startsWith('y')) {
      rl.close();
      console.log(c('No changes made.', DIM));
      return;
    }
    const entry = { ...existing };
    entry.ssh_host = await _rlPrompt(rl, 'SSH host', existing.ssh_host || '');
    entry.ssh_user = await _rlPrompt(rl, 'SSH user', existing.ssh_user || 'ubuntu');
    entry.ssh_key  = await _rlPrompt(rl, 'SSH key path', existing.ssh_key  || '/etc/suitecrm-mcp/crm-ssh-key');
    if (existing.command !== undefined || entry.command)
      entry.command = await _rlPrompt(rl, 'Provisioning command', existing.command || '');
    rl.close();
    hosts[opts.entity] = entry;
    saveJson(HOSTS_FILE, hosts);
    console.log(c(`\nUpdated crm-hosts entry for ${opts.entity}:`, GREEN));
    console.log(JSON.stringify(entry, null, 2));
  } else {
    console.log(c(`\nNo existing entry for ${opts.entity}. Enter values (blank = skip):`, YELLOW));
    const rl  = createInterface({ input: process.stdin, output: process.stdout });
    const entry = {};
    entry.ssh_host = await _rlPrompt(rl, 'SSH host (IP or hostname)');
    if (!entry.ssh_host) { rl.close(); console.log(c('No SSH host provided — aborted.', RED)); process.exit(1); }
    entry.ssh_user = await _rlPrompt(rl, 'SSH user', 'ubuntu');
    entry.ssh_key  = await _rlPrompt(rl, 'SSH key path', '/etc/suitecrm-mcp/crm-ssh-key');
    rl.close();
    hosts[opts.entity] = entry;
    saveJson(HOSTS_FILE, hosts);
    console.log(c(`\nCreated crm-hosts entry for ${opts.entity}:`, GREEN));
    console.log(JSON.stringify(entry, null, 2));
  }
}

// ── revoke ───────────────────────────────────────────────────────────────────

async function cmdRevoke(opts) {
  await connect();
  const sessions = await loadAllSessions();
  const now      = nowMs();

  let matchKey, matchVal;
  if (opts.sub)        { matchKey = 'sub';   matchVal = opts.sub; }
  else if (opts.email) { matchKey = 'email'; matchVal = opts.email.toLowerCase(); }
  else {
    console.error(c('Error: --sub or --email required', RED));
    await disconnect(); process.exit(1);
  }

  const toDelete = Object.entries(sessions).filter(([, s]) =>
    (s[matchKey] || '').toLowerCase() === matchVal.toLowerCase() &&
    (s.expiresAt || 0) > now);

  if (!toDelete.length) {
    console.log(c('No active sessions found for that user.', YELLOW));
    await disconnect(); return;
  }

  for (const [tok, s] of toDelete) {
    await deleteSession(tok);
    console.log(c(`Revoked token ${tok.slice(0, 20)}... for ${s.email || matchVal}`, GREEN));
  }
  console.log(c('Done. User must re-authenticate via the gateway URL to get a new token.', DIM));
  await disconnect();
}

// ── sessions ─────────────────────────────────────────────────────────────────

async function cmdSessions(opts) {
  await connect();
  const sessions = await loadAllSessions();
  const now      = nowMs();

  const active  = Object.entries(sessions).filter(([, s]) => (s.expiresAt || 0) >  now);
  const expired = Object.entries(sessions).filter(([, s]) => (s.expiresAt || 0) <= now);

  if (opts.purgeExpired && expired.length) {
    for (const [tok] of expired) await deleteSession(tok);
    console.log(c(`Purged ${expired.length} expired session(s)`, GREEN));
  }

  const display = opts.purgeExpired
    ? active
    : [...active, ...expired].sort((a, b) => (b[1].expiresAt || 0) - (a[1].expiresAt || 0));

  if (!display.length) { console.log(c('No sessions.', DIM)); await disconnect(); return; }

  console.log(c(`${active.length} active, ${opts.purgeExpired ? 0 : expired.length} expired\n`, BOLD));
  for (const [tok, s] of display) {
    const isExp  = (s.expiresAt || 0) <= now;
    const status = isExp ? c('expired', RED) : c('active', GREEN);
    console.log(`  ${tok.slice(0, 20)}...  ${c(s.email || '?', CYAN)}  ${status}  expires ${ts(s.expiresAt || 0)}`);
  }
  await disconnect();
}

// ── health helpers ────────────────────────────────────────────────────────────

function buildPortList(entities) {
  return Object.entries(entities)
    .filter(([, cfg]) => cfg.port)
    .sort((a, b) => a[1].port - b[1].port)
    .map(([code, cfg]) => ({ code, port: cfg.port, label: cfg.label || code }));
}

async function printHealth(ports, deep) {
  const path = deep ? '/health/deep' : '/health';
  let anyBad = false;

  for (const { code, port, label } of ports) {
    const { data, error } = await fetchHealth(port, path);
    if (!data) {
      console.log(`  ${c(code, BOLD)} (${label})  port ${port}  ${c(error || 'unreachable', RED)}`);
      anyBad = true; continue;
    }
    const sval = data.status || '?';
    const ok   = ['ok', 'healthy'].includes(sval);
    if (!ok) anyBad = true;
    const cb   = data.circuit_breaker || '?';
    if (!deep) {
      console.log(
        `  ${c(code, BOLD)} (${label})  port ${port}` +
        `  status=${c(sval, ok ? GREEN : RED)}` +
        `  active=${data.active ?? '?'}` +
        `  circuit_breaker=${c(cb, cb === 'closed' ? GREEN : RED)}`
      );
    } else {
      console.log(
        `  ${c(code, BOLD)} (${label})  port ${port}` +
        `  status=${c(sval, ok ? GREEN : RED)}` +
        `  connections=${data.connections ?? '?'}` +
        `  circuit_breaker=${c(cb, cb === 'closed' ? GREEN : RED)}` +
        `  uptime=${data.uptime ?? '?'}s` +
        `  duration=${data.duration_ms ?? '?'}ms`
      );
      for (const [name, chk] of Object.entries(data.checks || {})) {
        const cstat = chk.status || '?';
        const cok   = cstat === 'ok';
        if (!cok) anyBad = true;
        let extra = '';
        if (chk.latency_ms != null) extra += `  latency=${chk.latency_ms}ms`;
        if (chk.url)                extra += `  url=${chk.url}`;
        if (chk.active != null)     extra += `  active=${chk.active}`;
        console.log(`    ${name}: ${c(cstat, cok ? GREEN : RED)}${extra}`);
      }
      console.log();
    }
  }
  return anyBad;
}

async function cmdHealth(opts, deep = false) {
  const entities = loadJson(ENTITIES_FILE);
  const ports    = buildPortList(entities);
  const interval = opts.watch;

  const run = async () => {
    if (interval) {
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(c(new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', DIM));
    }
    return printHealth(ports, deep);
  };

  if (!interval) {
    const anyBad = await run();
    if (anyBad) process.exit(1);
    return;
  }

  while (true) {
    await run();
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

// ── entities ─────────────────────────────────────────────────────────────────

async function cmdEntities() {
  await connect();
  const entities = loadJson(ENTITIES_FILE);
  const profiles = await loadAllProfiles();
  const sessions = await loadAllSessions();
  const now      = nowMs();

  if (!Object.keys(entities).length) {
    console.log(c('No entities configured.', YELLOW));
    await disconnect(); return;
  }

  const userCounts = {}, sessionCounts = {};
  for (const p of Object.values(profiles)) {
    for (const code of Object.keys(p.entities || {})) {
      userCounts[code] = (userCounts[code] || 0) + 1;
    }
  }
  for (const s of Object.values(sessions)) {
    if ((s.expiresAt || 0) > now) {
      for (const code of Object.keys(profiles[s.sub]?.entities || {})) {
        sessionCounts[code] = (sessionCounts[code] || 0) + 1;
      }
    }
  }

  for (const [code, cfg] of Object.entries(entities).sort((a, b) => (a[1].port || 0) - (b[1].port || 0))) {
    let healthStr = '';
    if (cfg.port) {
      const { data } = await fetchHealth(cfg.port, '/health');
      if (!data) {
        healthStr = c('unreachable', RED);
      } else {
        const sval = data.status || '?';
        const ok   = ['ok', 'healthy'].includes(sval);
        const cb   = data.circuit_breaker || '?';
        healthStr  = c(sval, ok ? GREEN : RED);
        if (cb !== 'closed') healthStr += '  ' + c(`circuit_breaker=${cb}`, RED);
      }
    }

    console.log(`${c(code, BOLD + CYAN)}  ${c(cfg.label || code, BOLD)}`);
    console.log(`  port:     ${cfg.port || '?'}`);
    console.log(`  endpoint: ${cfg.endpoint || '?'}`);
    console.log(`  group:    ${cfg.group || '?'}`);
    console.log(`  users:    ${userCounts[code] || 0}`);
    console.log(`  sessions: ${sessionCounts[code] || 0} active`);
    console.log(`  health:   ${healthStr}`);
    console.log();
  }
  await disconnect();
}

// ── restart ───────────────────────────────────────────────────────────────────

async function cmdRestart(entityArg, opts) {
  const entities = loadJson(ENTITIES_FILE);
  let codes;

  if (!opts.all && !entityArg && !opts.monitoring) {
    console.error(c('Error: specify an entity code, --all, or --monitoring', RED));
    process.exit(1);
  }

  if (opts.all) {
    codes = Object.keys(entities).sort();
  } else if (entityArg) {
    if (!(entityArg in entities)) {
      console.error(c(`Unknown entity: ${entityArg}`, RED));
      process.exit(1);
    }
    codes = [entityArg];
  } else {
    codes = [];
  }

  let anyBad = false;

  // Restart monitoring stack if --monitoring (or --all --monitoring)
  if (opts.monitoring) {
    process.stdout.write(`  ${c('monitoring', BOLD)} (Monitoring Stack)  restarting ... `);
    try {
      await execFileAsync('systemctl', ['restart', 'suitecrm-mcp-monitoring.service']);
      console.log(c('OK', GREEN));
    } catch (e) {
      console.log(c('FAILED', RED));
      const msg = (e.stderr || e.message || '').trim();
      if (msg) console.log(`    ${c(msg, RED)}`);
      anyBad = true;
    }
  }

  // Always restart auth service first when --all
  if (opts.all) {
    process.stdout.write(`  ${c('auth', BOLD)} (Auth Service)  restarting ... `);
    try {
      await execFileAsync('systemctl', ['restart', 'suitecrm-mcp-auth.service']);
      const deadline = Date.now() + 10000;
      let ok = false;
      while (Date.now() < deadline) {
        const { data } = await fetchHealth(3100, '/health');
        if (data && data.status === 'ok') { ok = true; break; }
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(ok ? c('OK', GREEN) : c('restarted but health check timed out', YELLOW));
      if (!ok) anyBad = true;
    } catch (e) {
      console.log(c('FAILED', RED));
      const msg = (e.stderr || e.message || '').trim();
      if (msg) console.log(`    ${c(msg, RED)}`);
      anyBad = true;
    }
  }

  for (const code of codes) {
    const unit  = `suitecrm-mcp-${code}.service`;
    const label = entities[code]?.label || code;
    process.stdout.write(`  ${c(code, BOLD)} (${label})  restarting ... `);
    try {
      await execFileAsync('systemctl', ['restart', unit]);
    } catch (e) {
      console.log(c('FAILED', RED));
      const msg = (e.stderr || e.message || '').trim();
      if (msg) console.log(`    ${c(msg, RED)}`);
      anyBad = true; continue;
    }

    const port = entities[code]?.port;
    if (!port) { console.log(c('restarted (no port to verify)', YELLOW)); continue; }

    const deadline = Date.now() + 10000;
    let ok = false;
    while (Date.now() < deadline) {
      const { data } = await fetchHealth(port, '/health');
      if (data && ['ok', 'healthy'].includes(data.status)) { ok = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log(ok ? c('OK', GREEN) : c('restarted but health check timed out', YELLOW));
    if (!ok) anyBad = true;
  }
  if (anyBad) process.exit(1);
}

// ── stats ─────────────────────────────────────────────────────────────────────

async function cmdStats() {
  await connect();
  const profileCount = Object.keys(await redis.hgetall('crm:profiles') || {}).length;
  const sessions = [];
  for await (const batch of scanKeys('auth:session:*')) {
    sessions.push(...batch);
  }
  const info = await redis.info('memory');

  console.log('\n--- SuiteCRM MCP Stats ---');
  console.log(`User Profiles:    ${profileCount}`);
  console.log(`Active Sessions:  ${sessions.length}`);
  const m = info.match(/used_memory_human:([^\r\n]+)/);
  if (m) console.log(`Redis Memory:     ${m[1].trim()}`);
  console.log();
  await disconnect();
}

// ── logs ──────────────────────────────────────────────────────────────────────

const PINO_LEVELS = { 10:'TRACE', 20:'DEBUG', 30:'INFO ', 40:'WARN ', 50:'ERROR', 60:'FATAL' };
const PINO_COLORS = { 10:DIM, 20:DIM, 30:GREEN, 40:YELLOW, 50:RED, 60:RED+BOLD };
const LEVEL_NAMES = { trace:10, debug:20, info:30, warn:40, error:50, fatal:60 };
const JOURNAL_RE  = /^\S+\s+\S+\s+([\w-]+)\[\d+\]:\s*(.*)$/;

function formatLogLine(raw, minLevel, multiUnit) {
  const m        = raw.match(JOURNAL_RE);
  const unitFull = m ? m[1] : '';
  const msgStr   = m ? m[2] : raw;
  const entity   = unitFull.replace(/^suitecrm-mcp-/, '');

  let parsed = null;
  try { parsed = JSON.parse(msgStr); } catch {}

  if (!parsed) {
    if (minLevel > 0) return;
    const prefix = (multiUnit && entity) ? c(entity.padEnd(6), CYAN) + '  ' : '';
    process.stdout.write(prefix + raw + '\n');
    return;
  }

  const level    = parsed.level || 30;
  if (level < minLevel) return;

  const timeStr  = parsed.time ? new Date(parsed.time).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '';
  const levelStr = PINO_LEVELS[level] || String(level).padEnd(5);
  const levelCol = PINO_COLORS[level] || '';
  const reqId    = parsed.reqId ? c(parsed.reqId.slice(0, 8), DIM) + '  ' : '';
  const tool     = parsed.tool  ? c(parsed.tool, BOLD) + '  '            : '';
  const logMsg   = parsed.msg   || '';
  const errMsg   = parsed.err
    ? '  ' + c(typeof parsed.err === 'object' ? (parsed.err.message || JSON.stringify(parsed.err)) : parsed.err, RED)
    : '';
  const entityPart = (multiUnit && entity) ? c(entity.padEnd(6), CYAN) + '  ' : '';

  process.stdout.write(
    `${c(timeStr, DIM)}  ${c(levelStr, levelCol)}  ${entityPart}${reqId}${tool}${logMsg}${errMsg}\n`
  );
}

async function cmdLogs(entityArg, opts) {
  const entities = loadJson(ENTITIES_FILE);

  let units = [];
  if (entityArg) {
    const code = entityArg.toLowerCase();
    if (code === 'auth') {
      units = ['suitecrm-mcp-auth.service'];
    } else {
      if (!(code in entities)) {
        console.error(c(`Unknown entity: ${entityArg}. Valid: ${Object.keys(entities).sort().join(', ')}, auth`, RED));
        process.exit(1);
      }
      units = [`suitecrm-mcp-${code}.service`];
    }
  } else {
    units = Object.keys(entities).sort().map(code => `suitecrm-mcp-${code}.service`);
    if (opts.auth) units.unshift('suitecrm-mcp-auth.service');
  }

  const minLevel = LEVEL_NAMES[opts.level?.toLowerCase()] ?? 0;

  const jArgs = ['--no-pager', '-o', 'short-iso'];
  for (const u of units) jArgs.push('-u', u);
  jArgs.push('-n', String(opts.lines ?? 50));
  if (opts.follow) jArgs.push('-f');
  if (opts.since)  jArgs.push('--since', opts.since);

  const multiUnit = units.length > 1;
  const proc = spawn('journalctl', jArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) { if (line.trim()) formatLogLine(line, minLevel, multiUnit); }
  });
  proc.stdout.on('end', () => { if (buf.trim()) formatLogLine(buf, minLevel, multiUnit); });
  proc.stderr.on('data', chunk => process.stderr.write(chunk));

  await new Promise(resolve => proc.on('exit', resolve));
}

// ── flush ─────────────────────────────────────────────────────────────────────

async function cmdFlush(opts) {
  if (!opts.yesIAmSure) {
    console.error(c('Add --yes-i-am-sure to confirm flushing ALL sessions.', RED));
    process.exit(1);
  }
  await connect();
  let count = 0;
  for await (const batch of scanKeys('auth:session:*')) {
    for (const key of batch) { await redis.del(key); count++; }
  }
  console.log(c(`Flushed ${count} sessions. All users must re-authenticate.`, GREEN));
  await disconnect();
}

// ── CLI definition ────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('mcp-admin')
  .description('SuiteCRM MCP Gateway admin tool')
  .version('5.1.1');

program
  .command('list')
  .description('List user profiles')
  .option('--user <email>',   'Filter by email or username')
  .option('--entity <code>',  'Filter by entity code')
  .option('--show-pass',      'Show full password (default: masked)')
  .action(cmdList);

program
  .command('add')
  .description('Add or update a user profile / entity credentials')
  .option('--sub <sub>',       'Auth sub identifier')
  .option('--email <email>',   'User email (alternative to --sub)')
  .option('--entity <code>',   'Entity code to set credentials for')
  .option('--user <username>', 'CRM username')
  .option('--pass <password>', 'CRM password')
  .action(cmdAdd);

program
  .command('remove')
  .description('Remove a user profile or entity access')
  .option('--sub <sub>',     'Auth sub identifier')
  .option('--email <email>', 'User email')
  .option('--entity <code>', 'Remove only this entity (omit to remove whole profile)')
  .action(cmdRemove);

program
  .command('whoami')
  .description('Show user profile and active sessions')
  .option('--sub <sub>',     'Auth sub identifier')
  .option('--email <email>', 'User email')
  .action(cmdWhoami);

program
  .command('test')
  .description('Test CRM login for user(s)')
  .option('--sub <sub>',     'Auth sub (omit to test all users)')
  .option('--email <email>', 'User email')
  .option('--entity <code>', 'Entity to test (omit to test all entities for matched users)')
  .option('--verify-tls',    'Enable TLS certificate verification (default: off)')
  .action(cmdTest);

program
  .command('set-crm-host')
  .description('Configure CRM SSH provisioning host for an entity')
  .requiredOption('--entity <code>', 'Entity code')
  .option('--ssh-host <host>',       'SSH host IP or hostname')
  .option('--ssh-user <user>',       'SSH username')
  .option('--command <cmd>',         'Provisioning command to run over SSH')
  .option('--ssh-key <path>',        'Path to SSH private key')
  .action(cmdSetCrmHost);

program
  .command('revoke')
  .description("Revoke a user's active sessions (forces re-authentication)")
  .option('--sub <sub>',     'Auth sub identifier')
  .option('--email <email>', 'User email')
  .action(cmdRevoke);

program
  .command('sessions')
  .description('List active gateway sessions')
  .option('--purge-expired', 'Delete expired sessions from Redis')
  .action(cmdSessions);

program
  .command('entities')
  .description('Show configured entities with user counts and live health')
  .action(cmdEntities);

program
  .command('health')
  .description('Show live status of all MCP gateway instances')
  .option('--watch [seconds]', 'Repeat every N seconds (default 5) until Ctrl-C', (v) => parseInt(v) || 5)
  .action((opts) => cmdHealth(opts, false));

program
  .command('health-deep')
  .description('Deep health check (CRM API ping) for all MCP gateway instances')
  .option('--watch [seconds]', 'Repeat every N seconds (default 5) until Ctrl-C', (v) => parseInt(v) || 5)
  .action((opts) => cmdHealth(opts, true));

program
  .command('restart')
  .description('Restart one or all MCP gateway instances')
  .argument('[entity]', 'Entity code to restart')
  .option('--all', 'Restart all gateway instances')
  .option('--monitoring', 'Restart the monitoring stack (Prometheus/Grafana/Loki)')
  .action(cmdRestart);

program
  .command('stats')
  .description('Show gateway statistics')
  .action(cmdStats);

program
  .command('flush')
  .description('EMERGENCY: Invalidate ALL active sessions')
  .option('--yes-i-am-sure', 'Confirm you want to kill ALL sessions')
  .action(cmdFlush);

program
  .command('logs')
  .description('Show logs from MCP gateway services')
  .argument('[entity]',      'Entity code (e.g. aesg, pcau) or "auth" — omit for all gateways')
  .option('-f, --follow',    'Stream logs in real time (like tail -f)')
  .option('-n, --lines <n>', 'Number of recent lines to show (default: 50)', v => parseInt(v) || 50, 50)
  .option('--since <time>',  'Show logs since time, e.g. "1h ago", "2026-05-18 10:00"')
  .option('--level <level>', 'Minimum log level: trace|debug|info|warn|error')
  .option('--auth',          'Include auth service when showing all gateways')
  .action(cmdLogs);

program.parseAsync(process.argv);
