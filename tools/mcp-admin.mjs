#!/usr/bin/env node
/**
 * SuiteCRM MCP Gateway Admin CLI
 * Profiles: Redis HASH crm:profiles (field=sub, value=JSON)
 * Sessions: Redis STRING keys auth:session:<token>
 */

import { Command } from 'commander';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import { createServer as createHttpServer, get as httpGet } from 'http';
import { createRequire } from 'module';
import { createConnection } from 'net';
import { connect as tlsConnect } from 'tls';
const _require = createRequire(import.meta.url);
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';

const execFileAsync = promisify(execFile);

// Load REDIS_URL from auth.env if not set in the shell environment
if (!process.env.REDIS_URL) {
  try {
    const envFile = readFileSync('/etc/suitecrm-mcp/auth.env', 'utf8');
    const match = envFile.match(/^REDIS_URL=(.+)$/m);
    if (match) process.env.REDIS_URL = match[1].trim();
  } catch { /* file missing - fall back to default below */ }
}
const REDIS_URL      = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ENTITIES_FILE  = process.env.ENTITIES_FILE || '/etc/suitecrm-mcp/entities.json';
const HOSTS_FILE     = process.env.CRM_HOSTS_FILE || '/etc/suitecrm-mcp/crm-hosts.json';
const REPO_DIR       = '/opt/suitecrm-mcp-server';
const NGINX_CONF     = '/etc/nginx/sites-available/suitecrm-mcp';
const REPORT_INTERNAL_PORT = 7999;
const PROVISION_SH   = `${REPO_DIR}/tools/crm-provision-user.sh`;
const FIND_CONFIG_SH = `${REPO_DIR}/scripts/find-suitecrm-config.sh`;

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

async function loadRateLimits(emailFilter) {
  const results = [];
  for await (const batch of scanKeys('rl:sse:*')) {
    for (const key of batch) {
      const email = key.slice('rl:sse:'.length);
      if (emailFilter && !email.toLowerCase().includes(emailFilter.toLowerCase())) continue;
      const [count, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
      results.push({ type: 'SSE', label: email, count: parseInt(count) || 0, ttl, max: 60 });
    }
  }
  for await (const batch of scanKeys('rl:msg:*')) {
    for (const key of batch) {
      const sid = key.slice('rl:msg:'.length);
      if (emailFilter) continue; // msg keys are session IDs, can't filter by email
      const [count, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
      results.push({ type: 'MSG', label: sid.slice(0, 20) + '...', count: parseInt(count) || 0, ttl, max: 100 });
    }
  }
  return results.sort((a, b) => b.count - a.count);
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
    const date = new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const daysLeft = Math.ceil((ms - Date.now()) / 86400000);
    const tag = daysLeft > 0 ? `${daysLeft}d left` : 'expired';
    return `${date}  (${tag})`;
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
      console.log(c(`No existing profile found - creating: ${sub}`, YELLOW));
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

  const entities = loadJson(ENTITIES_FILE);
  const allCodes = opts.entity ? [opts.entity] : Object.keys(entities || {});

  if (opts.entity) {
    if (!(opts.entity in (profiles[sub].entities || {}))) {
      console.log(c(`${opts.entity} not found in profile for ${email}`, YELLOW));
      await disconnect(); return;
    }
    delete profiles[sub].entities[opts.entity];
    await saveProfile(sub, profiles[sub]);
  } else {
    await deleteProfile(sub);
  }

  // Clear stale CRM sessions so the new profile gets fresh credentials on reconnect
  const sessionKeys = allCodes.map(code => `crm:session:${sub}:${code}`);
  if (sessionKeys.length) {
    const deleted = await redis.del(...sessionKeys);
    if (deleted > 0) console.log(c(`  Cleared ${deleted} cached CRM session(s)`, DIM));
  }

  // When removing a full profile, also revoke all active gateway auth sessions
  if (!opts.entity) {
    const authPattern = 'auth:session:*';
    let revokedAuth = 0;
    for await (const batch of scanKeys(authPattern)) {
      if (!batch.length) continue;
      const vals = await redis.mget(...batch);
      const toDelete = [];
      for (let i = 0; i < batch.length; i++) {
        try {
          const s = JSON.parse(vals[i] || 'null');
          if (s?.sub === sub) toDelete.push(batch[i]);
        } catch { /* ignore */ }
      }
      if (toDelete.length) {
        await redis.del(...toDelete);
        revokedAuth += toDelete.length;
      }
    }
    if (revokedAuth > 0) console.log(c(`  Revoked ${revokedAuth} active auth session(s)`, DIM));
  }

  console.log(c(opts.entity ? `Removed ${opts.entity} access for ${email}` : `Removed profile for ${email}`, GREEN));
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

  let passed = 0, failed = 0;
  for (const [, p] of targets) {
    const email = p.email || '?';
    for (const [code, creds] of Object.entries(p.entities || {})) {
      if (opts.entity && code !== opts.entity) continue;
      const ent = entities[code];
      // For dual v4+v8 setups the primary endpoint is v8 GraphQL; use v4_endpoint for the
      // REST login test because crmLogin uses the v4 SuiteCRM REST protocol.
      const endpoint = ent?.v4_endpoint || ent?.endpoint;
      if (!endpoint) {
        if (!opts.quiet) console.log(`  ${c(email, CYAN)}/${c(code, BOLD)}  ${c('no endpoint configured', YELLOW)}`);
        continue;
      }
      const label = ent?.label || code;
      if (!opts.quiet) process.stdout.write(`  ${c(email, CYAN)}/${c(code, BOLD)} (${label})  ... `);
      try {
        const result = await crmLogin(endpoint, creds.user, creds.pass, opts.verifyTls);
        const sid = result?.id;
        if (sid && sid !== '0' && sid !== 0 && sid !== '') {
          if (!opts.quiet) console.log(c('OK', GREEN));
          passed++;
        } else {
          if (opts.quiet) process.stdout.write(`  ${c(email, CYAN)}/${c(code, BOLD)} (${label})  ... `);
          console.log(c(`FAIL  (CRM returned id=${JSON.stringify(sid)})`, RED));
          failed++;
        }
      } catch (e) {
        if (opts.quiet) process.stdout.write(`  ${c(email, CYAN)}/${c(code, BOLD)} (${label})  ... `);
        console.log(c(`ERROR  ${e.message}`, RED));
        failed++;
      }
    }
  }
  if (opts.quiet) {
    const total = passed + failed;
    console.log(failed === 0 ? c(`All ${total} login(s) OK`, GREEN) : c(`${failed}/${total} failed`, RED));
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
    // Flags supplied - confirm before applying if entry already exists
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

  // No flags - go interactive
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
    if (!entry.ssh_host) { rl.close(); console.log(c('No SSH host provided - aborted.', RED)); process.exit(1); }
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

  let active  = Object.entries(sessions).filter(([, s]) => (s.expiresAt || 0) >  now);
  let expired = Object.entries(sessions).filter(([, s]) => (s.expiresAt || 0) <= now);

  if (opts.email) {
    const needle = opts.email.toLowerCase();
    const match  = ([, s]) => (s.email || '').toLowerCase().includes(needle);
    active  = active.filter(match);
    expired = expired.filter(match);
  }

  if (opts.purgeExpired && expired.length) {
    for (const [tok] of expired) await deleteSession(tok);
    console.log(c(`Purged ${expired.length} expired session(s)`, GREEN));
  }

  const display = opts.purgeExpired
    ? active
    : [...active, ...expired].sort((a, b) => (b[1].expiresAt || 0) - (a[1].expiresAt || 0));

  if (!display.length) { console.log(c('No sessions.', DIM)); }
  else {
    console.log(c(`${active.length} active, ${opts.purgeExpired ? 0 : expired.length} expired`, BOLD));
    console.log();

    // Build table rows first to compute column widths
    const rows = display.map(([tok, s]) => {
      const isExp   = (s.expiresAt || 0) <= now;
      const expDate = ts(s.expiresAt || 0);
      return {
        tok:    tok.slice(0, 20) + '...',
        email:  s.email || '?',
        isExp,
        expDate,
      };
    });

    const colWidths = {
      tok:     Math.max(...rows.map(r => r.tok.length)),
      email:   Math.max(...rows.map(r => r.email.length)),
      expDate: Math.max(...rows.map(r => r.expDate.length)),
    };

    for (const r of rows) {
      const statusCol = r.isExp ? c('expired'.padEnd(7), RED) : c('active '.padEnd(7), GREEN);
      console.log(
        `  ${c(r.tok.padEnd(colWidths.tok), DIM)}` +
        `  ${c(r.email.padEnd(colWidths.email), CYAN)}` +
        `  ${statusCol}` +
        `  ${r.expDate}`
      );
    }
  }

  if (opts.rateLimits) {
    const rls = await loadRateLimits(opts.email);
    console.log();
    console.log(c('Rate limits:', BOLD));
    if (!rls.length) {
      console.log(c('  (none active - RL keys expire after 60s of inactivity)', DIM));
    } else {
      const typeW  = Math.max(...rls.map(r => (r.type  || '').length));
      const labelW = Math.max(...rls.map(r => (r.label || '').length));
      for (const r of rls) {
        const pct    = r.count / r.max;
        const barCol = pct >= 0.8 ? RED : pct >= 0.5 ? YELLOW : GREEN;
        const bar    = `${r.count}/${r.max}`;
        const reset  = r.ttl > 0 ? `resets in ${r.ttl}s` : 'expiring';
        console.log(
          `  ${c(r.type.padEnd(typeW), BOLD)}` +
          `  ${r.label.padEnd(labelW)}` +
          `  ${c(bar.padStart(7), barCol)}` +
          `  ${c('(' + reset + ')', DIM)}`
        );
      }
    }
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
        const cstat   = chk.status || '?';
        const cok     = cstat === 'ok';
        const cneutral = ['unknown', 'not_configured'].includes(cstat);
        if (!cok && !cneutral) anyBad = true;
        let extra = '';
        if (chk.latency_ms != null) extra += `  latency=${chk.latency_ms}ms`;
        if (chk.url)                extra += `  url=${chk.url}`;
        if (chk.active != null)     extra += `  active=${chk.active}`;
        if (chk.message)            extra += `  msg=${chk.message}`;
        if (chk.note)               extra += `  (${chk.note})`;
        console.log(`    ${name}: ${c(cstat, cok ? GREEN : cneutral ? DIM : RED)}${extra}`);
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

  if (!opts.all && !entityArg && !opts.monitoring && !opts.redis) {
    console.error(c('Error: specify an entity code, --all, --monitoring, or --redis', RED));
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
    const MONITORING_DIR = '/opt/suitecrm-mcp-monitoring';
    process.stdout.write(`  ${c('monitoring', BOLD)} (Monitoring Stack)  restarting ... `);
    try {
      await execFileAsync('docker', ['compose', 'restart'], { cwd: MONITORING_DIR });
      // Hot-reload alertmanager config without a full container restart
      try {
        await execFileAsync('curl', ['-sf', '-X', 'POST', 'http://localhost:9093/-/reload']);
      } catch { /* non-fatal - alertmanager may not be running */ }
      console.log(c('OK', GREEN));
    } catch (e) {
      console.log(c('FAILED', RED));
      const msg = (e.stderr || e.message || '').trim();
      if (msg) console.log(`    ${c(msg, RED)}`);
      anyBad = true;
    }
  }

  // Restart Redis if --redis (or --all --redis)
  if (opts.redis) {
    process.stdout.write(`  ${c('redis', BOLD)} (Redis)  restarting ... `);
    console.log(c('WARNING: all active sessions will be lost', YELLOW));
    try {
      await execFileAsync('systemctl', ['restart', 'redis-server.service']);
      console.log(`  ${c('redis', BOLD)} (Redis)  ${c('OK', GREEN)}`);
    } catch (e) {
      console.log(`  ${c('redis', BOLD)} (Redis)  ${c('FAILED', RED)}`);
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

  const jArgs = ['--no-pager'];
  for (const u of units) jArgs.push('-u', u);
  jArgs.push('-n', String(opts.lines ?? 50));
  if (opts.follow) jArgs.push('-f');
  if (opts.since)  jArgs.push('--since', opts.since);

  const proc = spawn('journalctl', jArgs, { stdio: 'inherit' });
  await new Promise(resolve => proc.on('exit', resolve));
}

// ── setup-crm-host ────────────────────────────────────────────────────────────

function sshExec(sshArgs, { input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile('ssh', sshArgs, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: stderr.trim() }));
      else resolve(stdout);
    });
    if (input != null) { proc.stdin.write(input); proc.stdin.end(); }
  });
}

async function cmdSetupCrmHost(entityArg) {
  const hosts = loadJson(HOSTS_FILE);
  const code  = entityArg.toLowerCase();

  const hostCfg = hosts[code];
  if (!hostCfg) {
    const avail = Object.keys(hosts).join(', ') || 'none';
    console.error(c(`Entity '${code}' not in ${HOSTS_FILE}. Available: ${avail}`, RED));
    process.exit(1);
  }

  const { ssh_host, ssh_user = 'ubuntu', ssh_key = '/etc/suitecrm-mcp/crm-ssh-key' } = hostCfg;
  if (!ssh_host) {
    console.error(c(`No ssh_host configured for '${code}' in ${HOSTS_FILE}`, RED));
    process.exit(1);
  }

  for (const [label, path] of [['crm-provision-user.sh', PROVISION_SH], ['find-suitecrm-config.sh', FIND_CONFIG_SH]]) {
    if (!existsSync(path)) {
      console.error(c(`${label} not found at ${path} - run install.py to populate ${REPO_DIR}`, RED));
      process.exit(1);
    }
  }

  const sshOpts = ['-i', ssh_key, '-o', 'StrictHostKeyChecking=accept-new',
                   '-o', 'UserKnownHostsFile=/dev/null',
                   '-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes'];
  const target       = `${ssh_user}@${ssh_host}`;
  const provisionBin = '/usr/local/bin/crm-provision-user';

  // 1. SCP provision script
  console.log(c(`  [${code}] Copying provision script to ${target} ...`, CYAN));
  await new Promise((resolve, reject) => {
    execFile('scp', [...sshOpts, PROVISION_SH, `${target}:/tmp/crm-provision-user`],
      (err, _out, stderr) => err ? reject(Object.assign(err, { stderr })) : resolve());
  }).catch(e => {
    console.error(c(`  [${code}] scp failed: ${(e.stderr || e.message).trim().slice(0, 200)}`, RED));
    process.exit(1);
  });

  // 2. Install on remote
  await sshExec([...sshOpts, target,
    `sudo mv /tmp/crm-provision-user ${provisionBin} && sudo chmod 755 ${provisionBin}`])
  .catch(e => {
    console.error(c(`  [${code}] Remote install failed: ${(e.stderr || e.message).trim().slice(0, 200)}`, RED));
    process.exit(1);
  });

  console.log(c(`  [${code}] Provision script deployed to ${ssh_host}:${provisionBin}`, GREEN));

  // 3. Resolve SUITECRM_CONFIG - mirrors ansible/deploy.yml:
  //    1. Read from /etc/environment if already set
  //    2. Run find-suitecrm-config.sh as root and persist
  //    3. Manual prompt fallback
  console.log(c(`  [${code}] Resolving SUITECRM_CONFIG on ${ssh_host} ...`, CYAN));
  let configPath = '';

  // Step 1: check /etc/environment
  const envOut = await sshExec([...sshOpts, target,
    "grep '^SUITECRM_CONFIG=' /etc/environment 2>/dev/null | cut -d= -f2 | head -1"])
    .catch(() => '');
  const envCandidate = envOut.trim();
  if (envCandidate.startsWith('/')) {
    configPath = envCandidate;
    console.log(c(`  [${code}] SUITECRM_CONFIG already set: ${configPath}`, GREEN));
  }

  // Step 2: discover - same find command used inside crm-provision-user.sh
  if (!configPath) {
    console.log(c(`  [${code}] Not set - running discovery (may take a minute) ...`, CYAN));
    const findCmd = "sudo bash -c 'find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o" +
      " -name config.php -readable -print 2>/dev/null" +
      " | xargs -r grep -l dbconfig 2>/dev/null | head -1'";
    const out = await sshExec([...sshOpts, target, findCmd]).catch(() => '');
    const candidate = out.trim();
    if (candidate.startsWith('/')) {
      if (!/^\/[a-zA-Z0-9/_.\-]+$/.test(candidate)) {
        console.error(c(`  [${code}] Suspicious config path rejected: ${candidate}`, RED));
      } else {
        configPath = candidate;
        const shellQuoted = configPath.replace(/'/g, "'\\''");
        await sshExec([...sshOpts, target,
          `sudo grep -q '^SUITECRM_CONFIG=' /etc/environment 2>/dev/null || ` +
          `echo SUITECRM_CONFIG='${shellQuoted}' | sudo tee -a /etc/environment`])
          .catch(() => {});
        console.log(c(`  [${code}] SUITECRM_CONFIG=${configPath}`, GREEN));
      }
    }
  }

  // Step 3: manual prompt
  if (!configPath) {
    console.log(c(`  [${code}] Could not auto-detect - enter manually`, YELLOW));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    configPath = await new Promise(resolve => rl.question(`  [${code}] SUITECRM_CONFIG path on CRM VM: `, resolve));
    rl.close();
    configPath = configPath.trim();
    if (!configPath || !configPath.startsWith('/')) {
      console.error(c(`  [${code}] No valid path provided - aborted`, RED));
      process.exit(1);
    }
  }

  console.log(c(`  [${code}] SUITECRM_CONFIG=${configPath}`, GREEN));

  // 4. Build command and persist
  const shellQuote = s => `'${s.replace(/'/g, "'\\''")}'`;
  const apiPath  = hostCfg.api_path || '';
  const cmdParts = [`SUITECRM_CONFIG=${shellQuote(configPath)}`];
  if (apiPath) cmdParts.push(`API_PATH=${shellQuote(apiPath)}`);
  cmdParts.push(provisionBin);

  hostCfg.command = cmdParts.join(' ');
  delete hostCfg.api_path;
  saveJson(HOSTS_FILE, hosts);

  console.log(c(`\n  [${code}] crm-hosts.json updated:`, GREEN));
  console.log(JSON.stringify(hostCfg, null, 2));
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

// ── audit ─────────────────────────────────────────────────────────────────────

const AUDIT_DB  = '/var/log/suitecrm-mcp/audit.db';

const AUDIT_WRITE_TOOLS = new Set([
  'create','update','log_call','upsert',
  'create_task','create_note','set_note_attachment',
  'link_records','unlink_records',
]);

function openAuditDb() {
  if (!existsSync(AUDIT_DB)) return null;
  try {
    const Database = _require('better-sqlite3');
    const db = new Database(AUDIT_DB, { readonly: true });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    return db;
  } catch (e) {
    console.error(c(`Cannot open audit DB: ${e.message}`, RED));
    return null;
  }
}

function buildAuditQuery(opts, since, until, forSummary = false) {
  const where  = ['1=1'];
  const params = {};

  if (since) { where.push('ts >= @since'); params.since = since.toISOString(); }
  if (until) { where.push('ts <  @until'); params.until = until.toISOString(); }

  if (!opts.raw) where.push("msg != 'tool_call'");

  if (opts.email)  { where.push('email  LIKE @email');  params.email  = `%${opts.email}%`; }
  if (opts.entity) { where.push('entity = @entity');    params.entity = opts.entity; }
  if (opts.tool)   { where.push('tool   LIKE @tool');   params.tool   = `%${opts.tool}%`; }
  if (opts.module) { where.push('module LIKE @module'); params.module = `%${opts.module}%`; }
  if (opts.status) { where.push('status = @status');    params.status = opts.status; }

  if (opts.action === 'write') {
    where.push(`tool IN (${[...AUDIT_WRITE_TOOLS].map((_, i) => `@wt${i}`).join(',')})`);
    [...AUDIT_WRITE_TOOLS].forEach((t, i) => { params[`wt${i}`] = t; });
  } else if (opts.action === 'read') {
    where.push(`tool NOT IN (${[...AUDIT_WRITE_TOOLS].map((_, i) => `@wt${i}`).join(',')})`);
    [...AUDIT_WRITE_TOOLS].forEach((t, i) => { params[`wt${i}`] = t; });
  }

  const clause = where.join(' AND ');
  return { clause, params };
}

function auditFmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function cmdAudit(opts) {
  // ── resolve time range ──────────────────────────────────────────────────────
  let since, until;
  const now = new Date();
  if (opts.date) {
    since = new Date(opts.date + 'T00:00:00Z');
    until = new Date(since); until.setUTCDate(until.getUTCDate() + 1);
  } else if (opts.from || opts.to) {
    since = opts.from ? new Date(opts.from + 'T00:00:00Z') : null;
    until = opts.to   ? (() => { const d = new Date(opts.to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d; })() : null;
  } else {
    since = new Date(now - (opts.days ?? 7) * 86400000);
    until = null;
  }

  const db = openAuditDb();
  if (!db) {
    console.log(c('No audit database found yet - it will be created once the gateway receives its first tool call.', YELLOW));
    return;
  }

  const { clause, params } = buildAuditQuery(opts, since, until);

  // ── summary mode ────────────────────────────────────────────────────────────
  if (opts.summary) {
    // Per-user aggregates via SQL
    const summaryRows = db.prepare(`
      SELECT
        email,
        COUNT(*)                                                          AS calls,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)                AS errors,
        SUM(CASE WHEN tool IN (${[...AUDIT_WRITE_TOOLS].map(t => `'${t}'`).join(',')}) THEN 1 ELSE 0 END) AS writes,
        MAX(ts)                                                           AS last_seen,
        GROUP_CONCAT(DISTINCT entity)                                     AS entities
      FROM audit_log
      WHERE ${clause} AND msg != 'tool_call'
      GROUP BY email
      ORDER BY calls DESC
    `).all(params);

    if (!summaryRows.length) { console.log(c('No activity in this period.', DIM)); db.close(); return; }

    // Top-3 tools per user (separate query - GROUP_CONCAT can't rank)
    const topTools = {};
    for (const r of summaryRows) {
      const toolRows = db.prepare(`
        SELECT tool, COUNT(*) AS n FROM audit_log
        WHERE ${clause} AND msg != 'tool_call' AND email = @_email
        GROUP BY tool ORDER BY n DESC LIMIT 3
      `).all({ ...params, _email: r.email });
      topTools[r.email] = toolRows.map(t => `${t.tool}(${t.n})`).join('  ');
    }

    const total = summaryRows.reduce((s, r) => s + r.calls, 0);

    const rows = summaryRows.map(r => ({
      email:    r.email,
      calls:    String(r.calls),
      errs:     String(r.errors),
      writes:   String(r.writes),
      lastSeen: auditFmtTime(r.last_seen).slice(0, 16),
      ents:     (r.entities || '').split(',').filter(Boolean).sort().join(', '),
      top3:     topTools[r.email] || '-',
    }));

    const headers = ['User', 'Calls', 'Errors', 'Writes', 'Last Seen (UTC)', 'Entities', 'Top Tools'];
    const keys    = ['email','calls','errs','writes','lastSeen','ents','top3'];
    const widths  = keys.map((k, i) => Math.max(headers[i].length, ...rows.map(r => (r[k] || '').length)));

    const sep = '+-' + widths.map(w => '-'.repeat(w)).join('-+-') + '-+';
    const hdr = '| ' + headers.map((h, i) => h.padEnd(widths[i])).join(' | ') + ' |';
    console.log(sep); console.log(hdr); console.log(sep);
    for (const r of rows) {
      const hasErr = parseInt(r.errs) > 0;
      const row = '| ' + keys.map((k, i) => {
        const cell = (r[k] || '').padEnd(widths[i]);
        if (k === 'email') return c(cell, CYAN);
        if (k === 'errs' && hasErr) return c(cell, parseInt(r.errs) >= 10 ? RED : YELLOW);
        return cell;
      }).join(' | ') + ' |';
      console.log(row);
    }
    console.log(sep);
    console.log(`\n${c(String(rows.length), BOLD)} user(s) · ${c(String(total), BOLD)} tool completions`);
    db.close(); return;
  }

  // ── CSV mode ────────────────────────────────────────────────────────────────
  if (opts.csv) {
    const csvLine = (...cols) => cols.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    console.log(csvLine('ts','email','entity','tool','module','msg','status','duration_ms','req_id','err'));
    const stmt = db.prepare(`SELECT * FROM audit_log WHERE ${clause} ORDER BY ts ASC`);
    for (const row of stmt.iterate(params)) {
      console.log(csvLine(
        row.ts, row.email, row.entity, row.tool, row.module ?? '',
        row.msg, row.status ?? '', row.duration_ms ?? '', row.req_id ?? '', row.err ?? '',
      ));
    }
    db.close(); return;
  }

  // ── table mode (default) ─────────────────────────────────────────────────────
  const limit = opts.limit ?? 200;
  const dbRows = db.prepare(
    `SELECT * FROM audit_log WHERE ${clause} ORDER BY ts DESC LIMIT @_limit`
  ).all({ ...params, _limit: limit + 1 });

  const truncated = dbRows.length > limit;
  const rows = dbRows.slice(0, limit);

  if (!rows.length) { console.log(c('No matching records.', DIM)); db.close(); return; }

  const formatted = rows.map(rec => {
    const toolCol    = rec.module ? `${rec.tool} [${rec.module}]` : (rec.tool || '-');
    const statusPlain = rec.status || rec.msg || '-';
    const statusCol  = rec.status === 'error'
      ? c(statusPlain + (rec.err ? ` - ${rec.err.slice(0, 60)}` : ''), RED)
      : rec.status === 'dry_run' ? c(statusPlain, YELLOW)
      : c(statusPlain, GREEN);
    return {
      time:    auditFmtTime(rec.ts),
      email:   rec.email  || '?',
      entity:  rec.entity || '?',
      tool:    toolCol,
      status:  statusCol,
      ms:      rec.duration_ms != null ? String(rec.duration_ms) : '',
      _status: statusPlain,
      _tool:   toolCol.replace(/\x1b\[[0-9;]*m/g, ''),
    };
  });

  const headers = ['Time (UTC)', 'User', 'Entity', 'Tool [Module]', 'Status', 'ms'];
  const keys    = ['time','email','entity','_tool','_status','ms'];
  const widths  = keys.map((k, i) => Math.max(headers[i].length, ...formatted.map(r => (r[k] || '').length)));

  const sep = '+-' + widths.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const hdr = '| ' + headers.map((h, i) => h.padEnd(widths[i])).join(' | ') + ' |';
  console.log(sep); console.log(hdr); console.log(sep);
  for (const r of formatted) {
    console.log(
      `| ${c(r.time, DIM)}` +
      ` | ${c(r.email.padEnd(widths[1]), CYAN)}` +
      ` | ${r.entity.padEnd(widths[2])}` +
      ` | ${c(r._tool.padEnd(widths[3]), BOLD)}` +
      ` | ${r.status + ' '.repeat(Math.max(0, widths[4] - r._status.length))}` +
      ` | ${r.ms.padEnd(widths[5])} |`
    );
  }
  console.log(sep);

  const note = truncated ? c(` (newest ${limit} shown - use --limit N or --csv for more)`, DIM) : '';
  console.log(`\n${c(String(rows.length), BOLD)} record(s)${note}`);
  db.close();
}

// ── CLI definition ────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('mcp-admin')
  .description('SuiteCRM MCP Gateway admin tool')
  .version('5.2.2');

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
  .option('--quiet',         'Suppress OK lines - only show failures + summary')
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
  .command('setup-crm-host')
  .description('Deploy provision script to CRM VM and auto-detect SUITECRM_CONFIG')
  .argument('<entity>', 'Entity code (e.g. crm1, crm2)')
  .action(cmdSetupCrmHost);

program
  .command('revoke')
  .description("Revoke a user's active sessions (forces re-authentication)")
  .option('--sub <sub>',     'Auth sub identifier')
  .option('--email <email>', 'User email')
  .action(cmdRevoke);

program
  .command('sessions')
  .description('List active gateway sessions')
  .option('--email <email>',   'Filter by user email')
  .option('--purge-expired',   'Delete expired sessions from Redis')
  .option('--rate-limits',     'Show Redis rate limit counters')
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
  .option('--redis', 'Restart Redis (WARNING: terminates all active sessions)')
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
  .description('Raw journalctl output for MCP gateway services')
  .argument('[entity]',      'Entity code (e.g. aeau, aesg) or "auth" - omit for all gateways')
  .option('-f, --follow',    'Stream logs in real time (like tail -f)')
  .option('-n, --lines <n>', 'Number of recent lines to show (default: 50)', v => parseInt(v) || 50, 50)
  .option('--since <time>',  'Show logs since time, e.g. "1h ago", "2026-05-18 10:00"')
  .option('--auth',          'Include auth service when showing all gateways')
  .addHelpText('after', `
Purpose:
  Direct journalctl pass-through - for crash diagnostics and raw service output.
  For user activity (who called what, errors, write ops), use: mcp-admin audit

Examples:
  mcp-admin logs                        # last 50 lines from all gateways
  mcp-admin logs aeau                   # one entity only
  mcp-admin logs auth                   # auth service only
  mcp-admin logs --follow               # live tail
  mcp-admin logs --since "1h ago"       # last hour
  mcp-admin logs --since "2026-06-01"   # from a date
  mcp-admin logs -n 200                 # more lines`)
  .action(cmdLogs);

program
  .command('audit')
  .description('Query the persistent user activity audit log')
  .option('--email <email>',       'Filter by user email (partial match)')
  .option('--entity <code>',       'Filter by CRM entity (aeau, aesg, aeph, pcau)')
  .option('--tool <name>',         'Filter by tool name (partial match)')
  .option('--module <name>',       'Filter by CRM module (Contacts, Accounts, Leads…)')
  .option('--action <read|write>', 'Show only read or write operations')
  .option('--status <status>',     'Filter by result: success | error | dry_run')
  .option('--date <YYYY-MM-DD>',   'Show only a specific day')
  .option('--from <YYYY-MM-DD>',   'Start date (inclusive)')
  .option('--to <YYYY-MM-DD>',     'End date (inclusive)')
  .option('--days <N>',            'Last N days (default: 7)', v => parseInt(v) || 7, 7)
  .option('--summary',             'Show per-user summary table instead of individual rows')
  .option('--csv',                 'Output as CSV (for Excel / external tools)')
  .option('--raw',                 'Include tool_call start entries (default: completions only)')
  .option('--limit <N>',           'Max rows in table mode (default: 200)', v => parseInt(v) || 200, 200)
  .addHelpText('after', `
Examples:
  # Everything in the last 7 days (default view)
  mcp-admin audit

  # All activity for one user
  mcp-admin audit --email john@example.com

  # What a user did on a specific day
  mcp-admin audit --email john@example.com --date 2026-06-17

  # Date range investigation
  mcp-admin audit --email john@example.com --from 2026-06-01 --to 2026-06-15

  # Per-user summary - call counts, errors, write ops, last seen
  mcp-admin audit --summary
  mcp-admin audit --summary --days 30

  # All write operations (create, update, log_call…) this week
  mcp-admin audit --days 7 --action write

  # All errors - who triggered them, which tool, what went wrong
  mcp-admin audit --status error --days 14

  # Errors for a specific user
  mcp-admin audit --email john@example.com --status error

  # Everything on the Contacts module across all users
  mcp-admin audit --module Contacts --days 30

  # All activity on one CRM entity
  mcp-admin audit --entity aeau --days 7

  # Export a user's full history as CSV (for investigation / HR)
  mcp-admin audit --email john@example.com --days 365 --csv > john_activity.csv

  # Export everything this month as CSV
  mcp-admin audit --days 30 --csv > monthly_audit.csv

  # Show more than the default 200 rows
  mcp-admin audit --days 30 --limit 1000`)
  .action(cmdAudit);

// ── report ────────────────────────────────────────────────────────────────────

const ALERTMANAGER_YML = '/opt/suitecrm-mcp-monitoring/alertmanager.yml';

function loadSmtpConfig() {
  let text = '';
  try { text = readFileSync(ALERTMANAGER_YML, 'utf8'); } catch { return {}; }

  const get = (re, def = '') => { const m = text.match(re); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : def; };
  const tls_raw = get(/^\s*smtp_require_tls:\s*([^\s#]+)/m, 'true');

  const cfg = {
    host:     get(/^\s*smtp_smarthost:\s*['"]?([^\s'"#]+)/m),
    from:     get(/^\s*smtp_from:\s*['"]?([^\s'"#]+)/m),
    user:     get(/^\s*smtp_auth_username:\s*['"]?([^\s'"#]+)/m),
    password: get(/^\s*smtp_auth_password:\s*['"]?([^\s'"#]+)/m),
    tls:      !['false','0','no'].includes(tls_raw.toLowerCase()),
  };

  const m = text.match(/email_configs[\s\S]*?to:\s*['"]?([^\s'"#\n]+)/);
  cfg.to = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';

  // env overrides
  if (process.env.SMTP_HOST)  cfg.host     = process.env.SMTP_HOST;
  if (process.env.SMTP_USER)  cfg.user     = process.env.SMTP_USER;
  if (process.env.SMTP_PASS)  cfg.password = process.env.SMTP_PASS;
  if (process.env.SMTP_FROM)  cfg.from     = process.env.SMTP_FROM;
  if (process.env.REPORT_TO)  cfg.to       = process.env.REPORT_TO;
  return cfg;
}

function getReportRange(period, refDate, live = false) {
  const ref = new Date(refDate);
  if (!live) ref.setUTCHours(0, 0, 0, 0);
  const end = ref;
  let start, label;
  const fmt = d => d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', timeZone:'UTC' });
  if (period === 'daily') {
    start = new Date(end - 86400000);
    label = `Daily Report - ${start.toLocaleDateString('en-GB', { weekday:'long', day:'2-digit', month:'long', year:'numeric', timeZone:'UTC' })}`;
  } else if (period === 'weekly') {
    start = new Date(end - 7 * 86400000);
    label = `Weekly Report - ${fmt(start)} to ${live ? fmt(end) + ' (live)' : fmt(new Date(end - 86400000))}`;
  } else {
    start = new Date(end - 30 * 86400000);
    label = `Monthly Report - ${fmt(start)} to ${live ? fmt(end) + ' (live)' : fmt(new Date(end - 86400000))}`;
  }
  return { start, end, label };
}

function aggregateReport(rows) {
  const userCalls    = {};
  const userErrors   = {};
  const userWrites   = {};
  const userEntities = {};
  const userTools    = {};
  const toolTotals   = {};
  const entityTotals = {};
  const rawErrors    = [];
  let totalCalls = 0, totalErrors = 0, totalWrites = 0;

  for (const row of rows) {
    const email  = row.email  || 'unknown';
    const tool   = row.tool   || '';
    const entity = row.entity || '';
    const msg    = row.msg;

    if (msg === 'tool_done') {
      totalCalls++;
      userCalls[email]    = (userCalls[email]    || 0) + 1;
      userEntities[email] = userEntities[email] || new Set();
      userEntities[email].add(entity);
      userTools[email]    = userTools[email] || {};
      userTools[email][tool] = (userTools[email][tool] || 0) + 1;
      toolTotals[tool]    = (toolTotals[tool]    || 0) + 1;
      entityTotals[entity]= (entityTotals[entity]|| 0) + 1;
      if (AUDIT_WRITE_TOOLS.has(tool)) {
        totalWrites++;
        userWrites[email] = (userWrites[email] || 0) + 1;
      }
    } else if (msg === 'tool_error') {
      totalErrors++;
      totalCalls++;
      userCalls[email]  = (userCalls[email]  || 0) + 1;
      userErrors[email] = (userErrors[email] || 0) + 1;
      if (rawErrors.length < 50) rawErrors.push({ ts: row.ts, email, tool, entity, err: row.err || '' });
    }
  }

  return {
    userCalls, userErrors, userWrites,
    userEntities: Object.fromEntries(Object.entries(userEntities).map(([k,v]) => [k, [...v].sort()])),
    userTools, toolTotals, entityTotals,
    totalCalls, totalErrors, totalWrites, rawErrors,
  };
}

function buildReportHtml(stats, label, start, end, source = 'sqlite') {
  const { userCalls, userErrors, userWrites, userEntities, userTools, toolTotals, entityTotals,
          totalCalls, totalErrors, totalWrites, rawErrors } = stats;

  const usersByCall  = Object.entries(userCalls).sort((a,b) => b[1]-a[1]);
  const topTools     = Object.entries(toolTotals).sort((a,b) => b[1]-a[1]).slice(0,15);
  const topEntities  = Object.entries(entityTotals).sort((a,b) => b[1]-a[1]);
  const errPct       = totalCalls > 0 ? `${(totalErrors/totalCalls*100).toFixed(1)}%` : '0%';
  const fmtDate      = d => d.toISOString().slice(0,16).replace('T',' ') + ' UTC';

  const rowBg = n => n === 0 ? '' : n < 3 ? 'background:#fff3cd' : 'background:#f8d7da';

  const userRows = usersByCall.map(([email, calls]) => {
    const errs     = userErrors[email]   || 0;
    const writes   = userWrites[email]   || 0;
    const entities = (userEntities[email]|| []).join(', ');
    const top3     = Object.entries(userTools[email]||{}).sort((a,b)=>b[1]-a[1]).slice(0,3)
                       .map(([t,n]) => `${t} (${n})`).join(', ');
    const ep       = calls > 0 ? `${Math.round(errs/calls*100)}%` : '0%';
    const errCell  = errs ? `<span style="color:#dc3545;font-weight:bold">${errs} (${ep})</span>` : '0';
    return `<tr style="${rowBg(errs)}">
      <td style="padding:6px 10px;border-bottom:1px solid #dee2e6">${email}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;text-align:center">${calls}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;text-align:center">${errCell}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;text-align:center">${writes}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;font-size:13px">${top3}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #dee2e6">${entities}</td>
    </tr>`;
  }).join('');

  const toolRows = topTools.map(([tool, n]) => {
    const pct = totalCalls > 0 ? `${(n/totalCalls*100).toFixed(1)}%` : '0%';
    return `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;font-family:monospace;font-size:13px">${tool}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center">${n}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center;color:#888">${pct}</td>
    </tr>`;
  }).join('');

  const entityRows = topEntities.map(([ent, n]) => {
    const pct = totalCalls > 0 ? `${(n/totalCalls*100).toFixed(1)}%` : '0%';
    return `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid #dee2e6">${ent}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center">${n}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center;color:#888">${pct}</td>
    </tr>`;
  }).join('');

  const errorRows = rawErrors.map(e =>
    `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:11px;white-space:nowrap">${e.ts}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:12px">${e.email}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-family:monospace;font-size:12px">${e.tool}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:12px">${e.entity}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:12px;color:#721c24">${e.err.slice(0,250)}</td>
    </tr>`).join('');

  const noActivity = '<p style="color:#888;font-style:italic;padding:12px 0">No user activity recorded in this period.</p>';

  const statCards = [
    [totalCalls,  '#1a73e8', 'Total Calls'],
    [totalErrors, totalErrors ? '#dc3545' : '#28a745', `Errors (${errPct})`],
    [totalWrites, '#6f42c1', 'Write Ops'],
    [usersByCall.length, '#fd7e14', 'Active Users'],
  ].map(([v,color,lbl]) =>
    `<div style="text-align:center;flex:1;min-width:110px;padding:8px;border-right:1px solid #dee2e6">
      <div style="font-size:28px;font-weight:bold;color:${color}">${v}</div>
      <div style="font-size:12px;color:#666;margin-top:2px">${lbl}</div>
    </div>`).join('');

  const generatedAt = new Date().toISOString().slice(0,16).replace('T',' ') + ' UTC';

  const sourceBanner = source === 'hybrid' ? `
  <div style="margin-top:16px;padding:14px 18px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;font-size:13px;line-height:1.6">
    <strong style="color:#2e7d32">ℹ Data source: Audit database + Loki journal logs (hybrid)</strong><br>
    Recent calls (since the audit database became active) come from SQLite.
    Earlier calls in this period have been recovered from the Loki journal log archive -
    the data is equally complete for both sources (per-user, tool, entity, errors all available).<br><br>
    <strong>Going forward:</strong> As time passes, the audit database will cover the full report
    window and Loki supplementing will no longer be needed.
  </div>` : source === 'loki' ? `
  <div style="margin-top:16px;padding:14px 18px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;font-size:13px;line-height:1.6">
    <strong style="color:#e65100">⚠ Data source: Loki journal logs (historical fallback)</strong><br>
    The audit database had no records for this period. This is because a systemd sandbox
    misconfiguration (<code>ReadWritePaths</code> missing <code>/var/log/suitecrm-mcp</code>)
    silently blocked the gateway from writing to the audit database. That issue has now been fixed.<br><br>
    <strong>What you are seeing:</strong> All call data has been recovered from the journal log
    archive (Loki). Per-user breakdown, tool usage, entity breakdown, and error details are all
    fully available - this report is as complete as one sourced from the audit database.<br><br>
    <strong>Going forward:</strong> Every call is now being recorded in the audit database.
    Future reports for periods after the fix will use the audit database directly and will
    no longer show this banner.
  </div>` : source === 'none' ? `
  <div style="margin-top:16px;padding:14px 18px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;font-size:13px;color:#666">
    <strong>No data available</strong> - no activity was recorded in the audit database or journal logs for this period.
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>MCP Gateway - ${label}</title></head>
<body style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto;padding:20px;color:#333;font-size:14px">
  <div style="background:#1a73e8;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px">SuiteCRM MCP Gateway - Activity Report</h1>
    <p style="margin:4px 0 0;opacity:0.9;font-size:14px">${label}</p>
    <p style="margin:4px 0 0;opacity:0.75;font-size:12px">${fmtDate(start)} → ${fmtDate(end)}</p>
  </div>
  <div style="background:#f8f9fa;padding:16px 24px;border:1px solid #dee2e6;border-top:none;display:flex;gap:0;flex-wrap:wrap">
    ${statCards}
  </div>
  ${sourceBanner}
  <h2 style="margin-top:28px;font-size:16px">User Activity</h2>
  ${!userRows ? noActivity : `
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#e9ecef">
      <th style="padding:8px 10px;text-align:left">User</th>
      <th style="padding:8px 10px">Calls</th>
      <th style="padding:8px 10px">Errors</th>
      <th style="padding:8px 10px">Writes</th>
      <th style="padding:8px 10px;text-align:left">Top Tools</th>
      <th style="padding:8px 10px;text-align:left">Entities</th>
    </tr></thead>
    <tbody>${userRows}</tbody>
  </table>
  <p style="font-size:11px;color:#999;margin-top:4px">Rows in orange/red have elevated error counts.</p>`}
  <div style="display:flex;gap:28px;margin-top:28px;flex-wrap:wrap">
    <div style="flex:1;min-width:260px">
      <h2 style="font-size:16px">Top Tools</h2>
      ${!toolRows ? noActivity : `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e9ecef">
          <th style="padding:6px 10px;text-align:left">Tool</th>
          <th style="padding:6px 10px">Calls</th>
          <th style="padding:6px 10px">%</th>
        </tr></thead>
        <tbody>${toolRows}</tbody>
      </table>`}
    </div>
    <div style="flex:0 0 220px">
      <h2 style="font-size:16px">Calls by Entity</h2>
      ${!entityRows ? noActivity : `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e9ecef">
          <th style="padding:6px 10px;text-align:left">Entity</th>
          <th style="padding:6px 10px">Calls</th>
          <th style="padding:6px 10px">%</th>
        </tr></thead>
        <tbody>${entityRows}</tbody>
      </table>`}
    </div>
  </div>
  ${rawErrors.length ? `
  <h2 style="color:#721c24;margin-top:32px;font-size:16px">Errors (${rawErrors.length} shown, ${totalErrors} total)</h2>
  <table style="width:100%;border-collapse:collapse;background:#fff5f5;font-size:13px">
    <thead><tr style="background:#f8d7da">
      <th style="padding:6px 8px;text-align:left">Time</th>
      <th style="padding:6px 8px;text-align:left">User</th>
      <th style="padding:6px 8px;text-align:left">Tool</th>
      <th style="padding:6px 8px;text-align:left">Entity</th>
      <th style="padding:6px 8px;text-align:left">Error</th>
    </tr></thead>
    <tbody>${errorRows}</tbody>
  </table>` : ''}
  <hr style="margin-top:40px;border:none;border-top:1px solid #dee2e6">
  <p style="font-size:11px;color:#bbb">Generated ${generatedAt} · SuiteCRM MCP Gateway · Data source: ${
    source === 'hybrid' ? 'Audit database + Loki journal logs (hybrid - full detail)' :
    source === 'loki'   ? 'Loki journal logs (historical fallback - full detail)' :
    source === 'sqlite' ? 'Audit database (full detail)' :
    'No data'
  }</p>
</body>
</html>`;
}

// Minimal SMTP client using Node.js built-ins - supports plain, STARTTLS, and SSL
async function sendSmtp(cfg, subject, htmlBody) {
  const hostPort = cfg.host || '';
  const colonIdx = hostPort.lastIndexOf(':');
  const host     = colonIdx > 0 ? hostPort.slice(0, colonIdx) : hostPort;
  const port     = colonIdx > 0 ? parseInt(hostPort.slice(colonIdx + 1)) : (cfg.tls ? 587 : 25);
  const user     = cfg.user     || '';
  const pass     = cfg.password || '';
  const from     = cfg.from     || user;
  const to       = cfg.to       || '';

  if (!host) throw new Error('No SMTP host configured (smtp_smarthost in alertmanager.yml)');
  if (!to)   throw new Error('No recipient configured (to: in alertmanager.yml email_configs or REPORT_TO env)');

  const recipients = to.split(',').map(s => s.trim()).filter(Boolean);
  const boundary   = `mcp_rpt_${Date.now().toString(36)}`;
  const plain      = `MCP Gateway Report: ${subject}\n\nOpen in an HTML email client.`;

  const msgLines = [
    `From: ${from}`,
    `To: ${recipients.join(', ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    plain,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ];
  const msgData = msgLines.join('\r\n');

  await new Promise((resolve, reject) => {
    let socket;

    const talk = (() => {
      let buf = '';
      const handlers = [];
      let current = null;

      const next = () => {
        if (handlers.length && !current) {
          current = handlers.shift();
          current();
        }
      };

      const queue = fn => { handlers.push(fn); next(); };

      const send = (line) => new Promise(res => queue(() => {
        socket.write(line + '\r\n');
        waitReply(res);
      }));

      const waitReply = (cb) => {
        current = null;
        const check = () => {
          const lines = buf.split('\r\n');
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (/^\d{3} /.test(l)) {
              buf = lines.slice(i + 1).join('\r\n');
              const code = parseInt(l.slice(0, 3));
              cb(code, l);
              next();
              return;
            }
          }
        };
        socket.on('data', function handler(chunk) {
          buf += chunk.toString();
          const lines = buf.split('\r\n');
          for (let i = 0; i < lines.length; i++) {
            if (/^\d{3} /.test(lines[i])) {
              socket.removeListener('data', handler);
              buf = lines.slice(i + 1).join('\r\n');
              const code = parseInt(lines[i].slice(0, 3));
              cb(code, lines[i]);
              next();
              return;
            }
          }
        });
      };

      return { send, waitReply, queue };
    })();

    const runSmtp = async (sock) => {
      socket = sock;
      socket.on('error', reject);
      socket.on('end', () => {});

      await new Promise(res => talk.waitReply(res)); // banner
      await talk.send(`EHLO mcp-admin`);

      if (cfg.tls && port !== 465) {
        const [stCode] = await new Promise(res => talk.send('STARTTLS').then((...a) => res(a)));
        if (stCode !== 220) throw new Error(`STARTTLS rejected: ${stCode}`);
        socket = tlsConnect({ socket, host, servername: host }, async () => {
          try {
            await talk.send(`EHLO mcp-admin`);
            if (user) {
              await talk.send('AUTH LOGIN');
              await talk.send(Buffer.from(user).toString('base64'));
              await talk.send(Buffer.from(pass).toString('base64'));
            }
            await talk.send(`MAIL FROM:<${from}>`);
            for (const r of recipients) await talk.send(`RCPT TO:<${r}>`);
            await talk.send('DATA');
            await new Promise(res => {
              socket.write(msgData + '\r\n.\r\n');
              talk.waitReply(res);
            });
            await talk.send('QUIT');
            resolve();
          } catch (e) { reject(e); }
        });
        socket.on('error', reject);
        return;
      }

      if (user) {
        await talk.send('AUTH LOGIN');
        await talk.send(Buffer.from(user).toString('base64'));
        await talk.send(Buffer.from(pass).toString('base64'));
      }
      await talk.send(`MAIL FROM:<${from}>`);
      for (const r of recipients) await talk.send(`RCPT TO:<${r}>`);
      await talk.send('DATA');
      await new Promise(res => {
        socket.write(msgData + '\r\n.\r\n');
        talk.waitReply(res);
      });
      await talk.send('QUIT');
      resolve();
    };

    if (port === 465) {
      socket = tlsConnect({ host, port, servername: host }, () => runSmtp(socket).catch(reject));
      socket.on('error', reject);
    } else {
      socket = createConnection({ host, port }, () => runSmtp(socket).catch(reject));
      socket.on('error', reject);
    }
  });
}

const LOKI_URL = 'http://127.0.0.1:3200';

async function fetchLokiStats(start, end) {
  const startNs = `${start.getTime()}000000`;
  const endNs   = `${end.getTime()}000000`;
  const query   = '{job="suitecrm-mcp"} | json | msg=~"tool_done|tool_error"';
  const url     = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startNs}&end=${endNs}&limit=5000&direction=forward`;

  let body = '';
  try {
    body = await new Promise((resolve, reject) => {
      const req = httpGet(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch { return null; }

  let result;
  try { result = JSON.parse(body); } catch { return null; }
  if (result.status !== 'success') return null;

  const streams = result.data?.result || [];
  if (!streams.length) return null;

  const rows = [];
  for (const stream of streams) {
    for (const [, line] of stream.values) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj.msg || !['tool_done', 'tool_error'].includes(obj.msg)) continue;

      // Normalize entity: suitecrm_pcau → pcau
      const rawEntity = obj.entity || stream.stream?.entity || '';
      const entity    = rawEntity.replace(/^suitecrm_/, '');

      // Normalize tool: suitecrm_pcau_search → search (strip entity prefix)
      const fullEntity = rawEntity.startsWith('suitecrm_') ? rawEntity : `suitecrm_${entity}`;
      const rawTool    = obj.tool || '';
      const tool       = rawTool.startsWith(fullEntity + '_') ? rawTool.slice(fullEntity.length + 1) : rawTool;

      rows.push({
        ts:          obj.time || '',
        email:       obj.email      || 'unknown',
        entity,
        tool,
        msg:         obj.msg,
        status:      obj.status     || null,
        duration_ms: obj.durationMs ?? null,
        req_id:      obj.reqId      || null,
        err:         obj.err        || null,
      });
    }
  }
  if (!rows.length) return null;
  return rows;
}

async function fetchLokiCallArgs(start, end, userEmail) {
  const startNs = `${start.getTime()}000000`;
  const endNs   = `${end.getTime()}000000`;
  const query   = `{job="suitecrm-mcp"} | json | msg="tool_call" | email="${userEmail}"`;
  const url     = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startNs}&end=${endNs}&limit=5000&direction=forward`;

  let body = '';
  try {
    body = await new Promise((resolve, reject) => {
      const req = httpGet(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch { return {}; }

  let result;
  try { result = JSON.parse(body); } catch { return {}; }
  if (result.status !== 'success') return {};

  const argsMap = {};
  for (const stream of (result.data?.result || [])) {
    for (const [, line] of stream.values) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj.reqId || !obj.args) continue;
      argsMap[obj.reqId] = obj.args;
    }
  }
  return argsMap;
}

function buildUserReportHtml(rows, email, label, start, end, source) {
  const fmtDate   = d => d.toISOString().slice(0,16).replace('T',' ') + ' UTC';
  const fmtMs     = ms => ms == null ? '-' : ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`;
  const generatedAt = new Date().toISOString().slice(0,16).replace('T',' ') + ' UTC';

  const success  = rows.filter(r => r.msg === 'tool_done' && r.status !== 'dry_run');
  const dryRuns  = rows.filter(r => r.status === 'dry_run');
  const errors   = rows.filter(r => r.msg === 'tool_error');

  const fmtArgs = args => {
    if (!args) return '';
    const parts = [];
    if (args.module) parts.push(`<span style="color:#495057">${args.module}</span>`);
    const id = args.id || args.record;
    if (id) parts.push(`<span style="font-family:monospace;color:#888;font-size:11px">${id.slice(0,8)}…</span>`);
    const fields = args.fields || args.name_value_list;
    if (fields && typeof fields === 'object') {
      const rendered = Object.entries(fields).map(([fk, fv]) =>
        fv === '[redacted]' ? `<span style="color:#aaa">${fk}</span>`
                            : `${fk}: <strong>${fv}</strong>`
      ).join(', ');
      if (rendered) parts.push(`<span style="font-size:11px;color:#6c757d">${rendered}</span>`);
    }
    return parts.join(' · ');
  };

  const callRow = (r, showErr = false) => `<tr>
    <td style="padding:5px 8px;border-bottom:1px solid #dee2e6;white-space:nowrap;font-size:11px;color:#888">${r.ts.slice(0,19).replace('T',' ')}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #dee2e6;font-family:monospace;font-size:12px">${r.tool}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #dee2e6;font-size:12px">${r.entity}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #dee2e6;font-size:12px">${fmtArgs(r.args)}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #dee2e6;text-align:right;font-size:12px;color:#888">${fmtMs(r.duration_ms)}</td>
    ${showErr ? `<td style="padding:5px 8px;border-bottom:1px solid #dee2e6;font-size:12px;color:#721c24">${(r.err||'').slice(0,200)}</td>` : ''}
  </tr>`;

  const thead = (withErr = false) => `<thead><tr style="background:#e9ecef">
    <th style="padding:6px 8px;text-align:left;font-size:12px">Time (UTC)</th>
    <th style="padding:6px 8px;text-align:left;font-size:12px">Tool</th>
    <th style="padding:6px 8px;text-align:left;font-size:12px">Entity</th>
    <th style="padding:6px 8px;text-align:left;font-size:12px">Detail</th>
    <th style="padding:6px 8px;text-align:right;font-size:12px">Duration</th>
    ${withErr ? '<th style="padding:6px 8px;text-align:left;font-size:12px">Error</th>' : ''}
  </tr></thead>`;

  const section = (title, color, items, withErr = false) => !items.length ? '' : `
  <h2 style="margin-top:28px;font-size:16px;color:${color}">${title} <span style="font-weight:normal;font-size:13px;color:#888">(${items.length})</span></h2>
  <div style="overflow-x:auto">
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    ${thead(withErr)}
    <tbody>${items.map(r => callRow(r, withErr)).join('')}</tbody>
  </table></div>`;

  const statCards = [
    [success.length,  '#28a745', 'Successful'],
    [dryRuns.length,  '#6f42c1', 'Dry Runs'],
    [errors.length,   errors.length ? '#dc3545' : '#28a745', 'Errors'],
    [rows.length,     '#1a73e8', 'Total Calls'],
  ].map(([v,color,lbl]) =>
    `<div style="text-align:center;flex:1;min-width:110px;padding:8px;border-right:1px solid #dee2e6">
      <div style="font-size:28px;font-weight:bold;color:${color}">${v}</div>
      <div style="font-size:12px;color:#666;margin-top:2px">${lbl}</div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>MCP User Report - ${email}</title></head>
<body style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto;padding:20px;color:#333;font-size:14px">
  <div style="background:#1a73e8;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px">SuiteCRM MCP - User Activity Report</h1>
    <p style="margin:4px 0 0;opacity:0.9;font-size:14px">${email}</p>
    <p style="margin:4px 0 0;opacity:0.85;font-size:13px">${label}</p>
    <p style="margin:4px 0 0;opacity:0.75;font-size:12px">${fmtDate(start)} → ${fmtDate(end)}</p>
  </div>
  <div style="background:#f8f9fa;padding:16px 24px;border:1px solid #dee2e6;border-top:none;display:flex;gap:0;flex-wrap:wrap">
    ${statCards}
  </div>
  ${section('Successful Calls', '#28a745', success)}
  ${section('Dry Runs', '#6f42c1', dryRuns)}
  ${section('Errors', '#dc3545', errors, true)}
  <hr style="margin-top:36px;border:none;border-top:1px solid #dee2e6">
  <p style="font-size:11px;color:#bbb">Generated ${generatedAt} · SuiteCRM MCP Gateway · Data source: ${
    source === 'hybrid' ? 'Audit database + Loki (hybrid)' :
    source === 'loki'   ? 'Loki journal logs' :
    source === 'sqlite' ? 'Audit database' : 'No data'
  }</p>
</body></html>`;
}

async function cmdReport(opts) {
  const db  = openAuditDb();
  const isLive = !opts.date;
  const ref = opts.date ? new Date(opts.date + 'T23:59:59Z') : new Date();
  const { start, end, label } = getReportRange(opts.period, ref, isLive);

  process.stderr.write(`[INFO] Period: ${start.toISOString()} → ${end.toISOString()}\n`);

  let stats, source;

  let sqliteRows = [];
  if (db) {
    sqliteRows = db.prepare(
      `SELECT ts, email, entity, tool, msg, status, duration_ms, req_id, err
       FROM audit_log
       WHERE ts >= ? AND ts < ? AND msg IN ('tool_done','tool_error')
       ORDER BY ts`
    ).all(start.toISOString(), end.toISOString());
    db.close();
    process.stderr.write(`[INFO] ${sqliteRows.length} SQLite entries\n`);
  }

  // Always try Loki - it covers the pre-fix period when SQLite was not writing.
  // Merge: take all Loki entries that predate the earliest SQLite entry, plus all SQLite entries.
  process.stderr.write('[INFO] Fetching Loki data...\n');
  const lokiRows = await fetchLokiStats(start, end);
  process.stderr.write(`[INFO] Loki: ${lokiRows ? lokiRows.length : 0} entries\n`);

  let allRows;
  if (sqliteRows.length > 0 && lokiRows && lokiRows.length > 0) {
    const firstSqliteTs = sqliteRows[0].ts;
    const lokiOnly = lokiRows.filter(r => r.ts < firstSqliteTs);
    process.stderr.write(`[INFO] Hybrid: ${lokiOnly.length} Loki-only + ${sqliteRows.length} SQLite entries\n`);
    allRows = [...lokiOnly, ...sqliteRows];
    source  = lokiOnly.length > 0 ? 'hybrid' : 'sqlite';
  } else if (sqliteRows.length > 0) {
    allRows = sqliteRows;
    source  = 'sqlite';
  } else if (lokiRows && lokiRows.length > 0) {
    allRows = lokiRows;
    source  = 'loki';
  } else {
    allRows = [];
    source  = 'none';
    process.stderr.write('[INFO] No data in SQLite or Loki - empty report\n');
  }

  let html;
  if (opts.user) {
    const userRows = allRows.filter(r => r.email === opts.user);
    process.stderr.write(`[INFO] ${userRows.length} entries for ${opts.user}\n`);
    process.stderr.write('[INFO] Fetching call args from Loki...\n');
    const argsMap = await fetchLokiCallArgs(start, end, opts.user);
    process.stderr.write(`[INFO] ${Object.keys(argsMap).length} call args found\n`);
    const rowsWithArgs = userRows.map(r => ({ ...r, args: r.req_id ? argsMap[r.req_id] || null : null }));
    html = buildUserReportHtml(rowsWithArgs, opts.user, label, start, end, source);
  } else {
    stats = aggregateReport(allRows);
    html  = buildReportHtml(stats, label, start, end, source);
  }

  if (opts.stdout) { process.stdout.write(html + '\n'); return; }

  if (opts.serve) {
    const tmpFile = pathJoin(mkdtempSync(pathJoin(tmpdir(), 'mcp-report-')), 'report.html');
    writeFileSync(tmpFile, html);

    // Resolve public base URL: prefer GATEWAY_PUBLIC_URL from auth.env, fall back to IP
    let publicBase = '';
    try {
      const envFile = readFileSync('/etc/suitecrm-mcp/auth.env', 'utf8');
      const m = envFile.match(/^GATEWAY_PUBLIC_URL=(.+)$/m);
      if (m) publicBase = m[1].trim().replace(/\/$/, '');
    } catch {}
    if (!publicBase) {
      let ip = '127.0.0.1';
      try {
        const { createSocket } = _require('dgram');
        await new Promise(resolve => {
          const s = createSocket('udp4');
          s.connect(53, '8.8.8.8', () => { ip = s.address().address; s.close(); resolve(); });
        });
      } catch {}
      const nginxPortFallback = (() => {
        try { const m = readFileSync(NGINX_CONF, 'utf8').match(/listen\s+(\d+)/); return m ? m[1] : '8080'; } catch { return '8080'; }
      })();
      publicBase = `http://${ip}:${nginxPortFallback}`;
    }

    // Try to proxy through nginx at /report (same port as everything else)
    const nginxConf = existsSync(NGINX_CONF) ? readFileSync(NGINX_CONF, 'utf8') : null;
    const useNginx  = nginxConf !== null && !nginxConf.includes('location /report');

    const NGINX_BLOCK = (
      '\n    # mcp-admin report --serve (temporary)\n' +
      `    location /report {\n` +
      `        proxy_pass http://127.0.0.1:${REPORT_INTERNAL_PORT}/;\n` +
      `        proxy_http_version 1.1;\n` +
      `        proxy_set_header Host $host;\n` +
      `        proxy_read_timeout 30s;\n` +
      `    }\n`
    );

    if (useNginx) {
      const patched = nginxConf.replace(/^}$/m, NGINX_BLOCK + '}');
      writeFileSync(NGINX_CONF, patched);
      try { await execFileAsync('nginx', ['-s', 'reload']); } catch {}
    }

    const cleanup = () => {
      if (useNginx) {
        try {
          const cur = readFileSync(NGINX_CONF, 'utf8');
          writeFileSync(NGINX_CONF, cur.replace(NGINX_BLOCK, ''));
          execFile('nginx', ['-s', 'reload'], () => {});
        } catch {}
      }
      try { unlinkSync(tmpFile); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    const srv = createHttpServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(tmpFile));
    });

    const listenPort = useNginx ? REPORT_INTERNAL_PORT : (parseInt(opts.serve, 10) || 8000);

    srv.listen(listenPort, '127.0.0.1', () => {
      console.log(c('[OK] Report ready - open in your browser:', GREEN));
      if (useNginx) {
        console.log(`     ${publicBase}/report`);
      } else {
        console.log(`     ${publicBase}/`);
      }
      console.log(c('     Press Ctrl+C to stop.', CYAN));
    });
    return;
  }

  const periodSubjects = {
    daily:   `[MCP Gateway] Daily Activity - ${start.toISOString().slice(0,10)}`,
    weekly:  `[MCP Gateway] Weekly Activity - w/e ${new Date(end - 86400000).toISOString().slice(0,10)}`,
    monthly: `[MCP Gateway] Monthly Activity - ${start.toLocaleDateString('en-GB', { month:'long', year:'numeric', timeZone:'UTC' })}`,
  };

  const cfg = loadSmtpConfig();
  try {
    await sendSmtp(cfg, periodSubjects[opts.period], html);
    console.log(c(`[OK] Report sent to: ${cfg.to}`, GREEN));
  } catch (e) {
    console.error(c(`[ERROR] Email failed: ${e.message}`, RED));
    process.exit(1);
  }
}

program
  .command('report')
  .description('Generate and email an activity report (daily/weekly/monthly)')
  .option('--period <period>', 'Report period: daily | weekly | monthly  (default: daily)', 'daily')
  .option('--date <YYYY-MM-DD>', 'Reference date - report covers the period ending on this day (default: today)')
  .option('--user <email>', 'Show per-user detail report for this email address')
  .option('--stdout', 'Print HTML to stdout instead of emailing (useful for testing)')
  .option('--serve [port]', 'Serve report in browser via nginx at /report (falls back to standalone on given port)')
  .addHelpText('after', `
SMTP config is read from ${ALERTMANAGER_YML} (same config Alertmanager uses).
Override any value with env vars: SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM, REPORT_TO.

Examples:
  mcp-admin report                                         # email daily report for yesterday
  mcp-admin report --period weekly                         # email weekly report
  mcp-admin report --period monthly                        # email monthly report
  mcp-admin report --stdout                                # print HTML, no email (quick test)
  mcp-admin report --date 2026-06-15                       # report for a specific day
  mcp-admin report --serve                                 # open in browser at /report
  mcp-admin report --period weekly --user bob@example.com --serve  # per-user detail report`)
  .action(cmdReport);

program.parseAsync(process.argv);
