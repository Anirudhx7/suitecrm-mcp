/**
 * SuiteCRM MCP Auth Service (auth.mjs)
 * Port 3100 - handles OAuth2 login + token polling
 */
import express from 'express';
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import pino from 'pino';
import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import http from 'http';
import rateLimit from 'express-rate-limit';

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function atomicWrite(path, data) {
  const tmp = path + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function parseCookies(req) {
  const list = {};
  const raw = req.headers.cookie;
  if (!raw) return list;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    try {
      list[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch { /* ignore malformed cookie values */ }
  }
  return list;
}


const execFileAsync = promisify(execFile);

const REQUIRED_AUTH = ['AUTH0_DOMAIN','AUTH0_CLIENT_ID','AUTH0_CLIENT_SECRET','AUTH0_AUDIENCE','GATEWAY_PUBLIC_URL'];
const missingAuth = REQUIRED_AUTH.filter(k => !process.env[k]);
if (missingAuth.length) { pino().error({ vars: missingAuth }, 'missing_required_env_vars'); process.exit(1); }

const AUTH0_DOMAIN        = process.env.AUTH0_DOMAIN;
const AUTH0_CLIENT_ID     = process.env.AUTH0_CLIENT_ID;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;
const AUTH0_AUDIENCE      = process.env.AUTH0_AUDIENCE;
const GATEWAY_URL         = process.env.GATEWAY_PUBLIC_URL;
const CALLBACK_URL        = `${GATEWAY_URL}/auth/callback`;
const PROFILES_FILE       = '/etc/suitecrm-mcp/user-profiles.json';
const SESSIONS_FILE       = '/etc/suitecrm-mcp/sessions.json';
const BRIDGE_SESSIONS_FILE = '/etc/suitecrm-mcp/bridge-sessions.json';
const CRM_HOSTS_FILE      = '/etc/suitecrm-mcp/crm-hosts.json';
const SESSION_TTL_MS      = parseInt(process.env.SESSION_TTL_DAYS || '30') * 24 * 60 * 60 * 1000;
const SESSION_TTL_DAYS    = parseInt(process.env.SESSION_TTL_DAYS || '30');
const BRIDGE_SESSION_TTL_MS = 15 * 60 * 1000;
const NS            = AUTH0_AUDIENCE + '/';
const GROUPS_CLAIM  = process.env.OAUTH_GROUPS_CLAIM || (NS + 'groups');

const logger = pino({
  base: { service: 'suitecrm-mcp-auth' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const metricLogins = new Counter({
  name: 'suitecrm_auth_logins_total',
  help: 'OAuth2 login completions',
  labelNames: ['result'],
  registers: [metricsRegistry],
});

const metricBridgeSessions = new Counter({
  name: 'suitecrm_auth_bridge_sessions_total',
  help: 'Bridge session events',
  labelNames: ['event'],
  registers: [metricsRegistry],
});

new Gauge({
  name: 'suitecrm_auth_sessions_active',
  help: 'Non-expired gateway sessions currently stored',
  registers: [metricsRegistry],
  collect() {
    this.reset();
    const now = Date.now();
    const sessions = loadSessions();
    this.set(Object.values(sessions).filter(s => s.expiresAt > now).length);
  },
});

// 64-char hex string (output of randomBytes(32).toString('hex'))
const NONCE_RE = /^[0-9a-f]{64}$/;
const API_KEY_RE = /^[0-9a-f]{64}$/;

// Safely extract a scalar string from a query param (prevents array injection)
function qs(v) { return typeof v === 'string' ? v : ''; }

function loadProfiles() {
  try { return JSON.parse(readFileSync(PROFILES_FILE, 'utf8')); } catch { return {}; }
}
function saveProfiles(p) {
  atomicWrite(PROFILES_FILE, p);
}
function loadSessions() {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(s) {
  atomicWrite(SESSIONS_FILE, s);
}
function loadBridgeSessions() {
  try { return JSON.parse(readFileSync(BRIDGE_SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveBridgeSessions(s) {
  atomicWrite(BRIDGE_SESSIONS_FILE, s);
}
function loadEntities() {
  try { return JSON.parse(readFileSync('/etc/suitecrm-mcp/entities.json', 'utf8')); } catch (e) {
    logger.warn({ err: e.message }, 'entities_load_failed');
    return {};
  }
}
function cleanExpiredBridgeSessions(sessions) {
  const now = Date.now();
  for (const [nonce, s] of Object.entries(sessions)) {
    if (s.expiresAt < now) delete sessions[nonce];
  }
  return sessions;
}
function cleanExpiredSessions(sessions) {
  const now = Date.now();
  for (const [token, s] of Object.entries(sessions)) {
    if (s.expiresAt < now) delete sessions[token];
  }
  return sessions;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     AUTH0_CLIENT_ID,
    client_secret: AUTH0_CLIENT_SECRET,
    code,
    redirect_uri:  CALLBACK_URL,
  });
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

function decodeJwtPayload(token) {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

async function verifyAndDecodeAccessToken(accessToken) {
  // Validate token server-side via Auth0 userinfo (rejects tampered/expired tokens)
  const uiRes = await fetch(`https://${AUTH0_DOMAIN}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!uiRes.ok) throw new Error(`Access token rejected by Auth0: ${uiRes.status}`);
  const userinfo = await uiRes.json();

  const payload = decodeJwtPayload(accessToken);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('Token expired');
  if (payload.iss && payload.iss !== `https://${AUTH0_DOMAIN}/`) {
    throw new Error(`Issuer mismatch: got ${payload.iss}`);
  }
  // Merge userinfo so profile claims (preferred_username, email) are available even when
  // the access token omits them. JWT payload wins on conflict.
  return { ...userinfo, ...payload };
}

async function provisionCrmAccounts(sub, email, crmUsername, userGroups) {
  let crmHosts = {};
  try { crmHosts = JSON.parse(readFileSync(CRM_HOSTS_FILE, 'utf8')); } catch {}

  const profiles = loadProfiles();
  if (!profiles[sub]) profiles[sub] = { email, name: email, entities: {} };
  profiles[sub].email = email || profiles[sub].email;
  profiles[sub].name  = email || profiles[sub].name;

  const crmUser = crmUsername;

  for (const [code, data] of Object.entries(loadEntities())) {
    const requiredGroup = data.group;
    const hasGroup = userGroups.some(g => g.toLowerCase() === requiredGroup.toLowerCase());
    if (!hasGroup) continue;
    if (profiles[sub].entities[code]?.user) continue;

    const crmPass = randomBytes(16).toString('hex');
    const host    = crmHosts[code];

    if (host?.ssh_host && host?.ssh_user && host?.command) {
      try {
        await execFileAsync('ssh', [
          '-i',  host.ssh_key || '/etc/suitecrm-mcp/ssh-key.pem',
          '-o',  'StrictHostKeyChecking=accept-new',
          '-o',  'ConnectTimeout=10',
          '-o',  'BatchMode=yes',
          `${host.ssh_user}@${host.ssh_host}`,
          host.command,
          crmUser,
          crmPass,
        ]);
        logger.info({ crmUser, entity: code }, 'crm_user_provisioned');
      } catch (err) {
        const msg = (err.stderr || err.message || '').trim().slice(0, 200);
        logger.error({ entity: code, err: msg }, 'crm_provision_failed');
        continue;
      }
    }

    profiles[sub].entities[code] = { user: crmUser, pass: crmPass };
  }

  saveProfiles(profiles);
  return profiles[sub];
}

const app = express();
app.use(express.json());
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// GET / -> redirect to /auth/login
app.get('/', (req, res) => {
  res.redirect('/auth/login');
});

// GET /auth/login -> OAuth2 flow
app.get('/auth/login', (req, res) => {
  const nonce  = qs(req.query.nonce) || undefined;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     AUTH0_CLIENT_ID,
    redirect_uri:  CALLBACK_URL,
    scope:         'openid profile email offline_access',
    audience:      AUTH0_AUDIENCE,
  });
  let state;
  if (nonce) {
    state = nonce;
  } else {
    state = randomBytes(16).toString('hex');
    // secure: true so browsers only send cookie over HTTPS; matches GATEWAY_URL protocol
    res.cookie('oa_state', state, { httpOnly: true, sameSite: 'lax', secure: GATEWAY_URL.startsWith('https://'), maxAge: 300000 });
  }
  params.set('state', state);
  res.redirect(`https://${AUTH0_DOMAIN}/authorize?${params}`);
});

// GET /auth/callback -> exchange code, provision CRM, store token, show success UI
app.get('/auth/callback', async (req, res) => {
  const code              = qs(req.query.code);
  const error             = qs(req.query.error);
  const error_description = qs(req.query.error_description);
  const state             = qs(req.query.state);
  const nonce = NONCE_RE.test(state) ? state : '';

  // CSRF check for direct browser logins (bridge flow uses nonce, already validated below)
  if (!nonce) {
    const cookies = parseCookies(req);
    const expected = cookies.oa_state || '';
    if (!expected || state !== expected) {
      logger.warn({ state: state.slice(0, 8) }, 'csrf_state_mismatch');
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;padding:40px">
          <h2>Invalid login state</h2>
          <p>The login session has expired or was tampered with. Please try again.</p>
          <p><a href="/auth/login">Back to login</a></p>
        </body></html>`);
    }
    res.clearCookie('oa_state');
  }

  if (error) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:40px">
        <h2>Authentication Error</h2>
        <p>${escHtml(error_description || error)}</p>
        <p>Please close this tab and try again.</p>
      </body></html>`);
  }

  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const tokens  = await exchangeCode(code);
    const payload = await verifyAndDecodeAccessToken(tokens.access_token);

    const sub        = payload.sub;
    const sam           = payload[`${NS}samaccountname`] || '';
    const preferredUser = payload.preferred_username || '';
    const email         = sam.includes('@') ? sam : (payload.email || preferredUser || '');
    const userGroups    = payload[GROUPS_CLAIM] || [];
    const linuxUser     = email.split('@')[0].toLowerCase();

    // Derive CRM username: samaccountname → preferred_username → email; reject if none resolvable
    const rawIdent    = sam || preferredUser || payload.email || '';
    const crmUsername = rawIdent
      ? (rawIdent.includes('@') ? rawIdent.split('@')[0].toLowerCase() : rawIdent.toLowerCase())
      : '';
    if (!crmUsername) {
      logger.warn({ sub: sub.slice(-8) }, 'login_rejected_no_crm_username');
      return res.status(400).send('Cannot determine CRM username from IdP claims. Contact your administrator.');
    }

    logger.info({ email, sub: sub.slice(-8) }, 'login');

    await provisionCrmAccounts(sub, email, crmUsername, userGroups);

    // Reuse existing valid session for this user, or create a new one directly in sessions.json
    const sessions = cleanExpiredSessions(loadSessions());
    const userSessions = Object.entries(sessions)
      .filter(([, s]) => s.sub === sub)
      .sort(([, a], [, b]) => b.createdAt - a.createdAt);

    let apiKey;
    let daysLeft;

    if (userSessions.length > 0) {
      [apiKey] = userSessions[0];
      daysLeft = Math.ceil((userSessions[0][1].expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
      // Clean up any older duplicate sessions for the same user
      for (let i = 1; i < userSessions.length; i++) delete sessions[userSessions[i][0]];
      if (userSessions.length > 1) saveSessions(sessions);
      logger.info({ email, daysLeft }, 'session_reused');
      metricLogins.inc({ result: 'reused' });
    } else {
      apiKey = randomBytes(32).toString('hex');
      sessions[apiKey] = {
        sub,
        email,
        linuxUser,
        groups:    userGroups,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      daysLeft = SESSION_TTL_DAYS;
      saveSessions(sessions);
      logger.info({ email }, 'session_created');
      metricLogins.inc({ result: 'new' });
    }

    if (nonce) {
      const bridgeSessions = loadBridgeSessions();
      if (Object.hasOwn(bridgeSessions, nonce)) {
        bridgeSessions[nonce].status = 'ready';
        bridgeSessions[nonce].apiKey  = apiKey;
        bridgeSessions[nonce].sub     = sub;
        bridgeSessions[nonce].email   = email;
        bridgeSessions[nonce].groups  = userGroups;
        saveBridgeSessions(bridgeSessions);
        logger.info({ nonce: nonce.slice(0, 16) }, 'bridge_session_ready');
      }
    }

    // Build entity list from entities.json filtered by user's groups
    const entities = [];
    const entitiesJson = loadEntities();
    for (const [code, data] of Object.entries(entitiesJson)) {
      const hasGroup = userGroups.some(g => g.toLowerCase() === (data.group||'').toLowerCase());
      if (hasGroup) entities.push({ code, label: data.label, port: data.port });
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>SuiteCRM MCP Gateway - Authenticated</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--brand-50:#eef2ff;--brand-100:#e0e7ff;--brand-200:#c7d2fe;--brand-400:#818cf8;--brand-500:#6366f1;--brand-600:#4f46e5;--brand-700:#4338ca;--emerald-400:#34d399;--emerald-500:#10b981}
    body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#f8faff 0%,#eef2ff 40%,#f5f3ff 100%);min-height:100vh;overflow-x:hidden;color:#1e293b}
    .orbs{position:fixed;inset:0;pointer-events:none;overflow:hidden}
    .orb{position:absolute;border-radius:50%}
    .orb-1{top:-8rem;left:-8rem;width:24rem;height:24rem;background:radial-gradient(circle,rgba(99,102,241,.15) 0%,transparent 70%);animation:float 6s ease-in-out infinite}
    .orb-2{top:-5rem;right:-5rem;width:20rem;height:20rem;background:radial-gradient(circle,rgba(139,92,246,.12) 0%,transparent 70%);animation:float-delayed 7s ease-in-out infinite}
    .orb-3{bottom:-10rem;left:-5rem;width:31rem;height:31rem;background:radial-gradient(circle,rgba(16,185,129,.10) 0%,transparent 70%);animation:float 6s ease-in-out infinite}
    .orb-4{bottom:-5rem;right:-8rem;width:18rem;height:18rem;background:radial-gradient(circle,rgba(244,114,182,.10) 0%,transparent 70%);animation:float-delayed 7s ease-in-out infinite}
    .orb-5{top:50%;left:50%;transform:translate(-50%,-50%);width:37rem;height:37rem;background:radial-gradient(circle,rgba(99,102,241,.06) 0%,transparent 60%);animation:pulse-glow 3s ease-in-out infinite}
    .grid-overlay{position:fixed;inset:0;pointer-events:none;opacity:.03;background-image:linear-gradient(rgba(99,102,241,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.5) 1px,transparent 1px);background-size:60px 60px}
    @keyframes float{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-20px) rotate(3deg)}}
    @keyframes float-delayed{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-15px) rotate(-2deg)}}
    @keyframes pulse-glow{0%,100%{opacity:.6;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.05)}}
    @keyframes fade-up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
    @keyframes scale-in{from{opacity:0;transform:scale(.85) rotate(-10deg)}to{opacity:1;transform:scale(1) rotate(0deg)}}
    @keyframes ring-out{from{transform:scale(0);opacity:.5}to{transform:scale(2.2);opacity:0}}
    @keyframes draw-check{from{stroke-dashoffset:60}to{stroke-dashoffset:0}}
    main{position:relative;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:4rem 1.5rem}
    .brand{display:flex;align-items:center;gap:.65rem;margin-bottom:3rem;opacity:0;animation:fade-up .5s ease forwards .1s}
    .brand-icon{width:2.25rem;height:2.25rem;border-radius:.75rem;background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 4px 12px rgba(99,102,241,.3);display:flex;align-items:center;justify-content:center}
    .brand-icon svg{width:1.1rem;height:1.1rem}
    .brand-name{font-family:'Outfit',sans-serif;font-weight:700;font-size:1.2rem;color:#1e293b;letter-spacing:-.02em}
    .checkmark-wrap{position:relative;width:7rem;height:7rem;margin:0 auto 2.5rem}
    .ring-pulse{position:absolute;inset:0;border-radius:50%;animation:ring-out 1.5s ease forwards}
    .ring-1{background:rgba(52,211,153,.2);animation-delay:.6s}
    .ring-2{background:rgba(52,211,153,.3);animation-delay:.8s}
    .check-circle{position:absolute;inset:0;border-radius:50%;background:linear-gradient(135deg,#34d399,#10b981,#059669);box-shadow:0 0 40px rgba(16,185,129,.4),0 0 80px rgba(16,185,129,.2);opacity:0;animation:scale-in .6s cubic-bezier(.22,1,.36,1) forwards .2s}
    .check-circle svg{width:100%;height:100%;padding:1.2rem}
    .check-path{stroke-dasharray:60;stroke-dashoffset:60;animation:draw-check .6s ease forwards .7s}
    .heading-block{text-align:center;margin-bottom:2.5rem;opacity:0;animation:fade-up .6s ease forwards 1s}
    .heading-block h1{font-family:'Outfit',sans-serif;font-weight:800;font-size:clamp(2rem,5vw,3rem);color:#0f172a;margin-bottom:.6rem;letter-spacing:-.03em}
    .heading-block p{color:#64748b;font-size:1rem;max-width:28rem;line-height:1.7}
    .heading-ready{color:var(--brand-600);font-weight:600}
    .glass-card{background:rgba(255,255,255,.72);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.55);border-radius:1.5rem}
    .user-card{width:100%;max-width:32rem;padding:2rem;margin-bottom:1rem;opacity:0;animation:fade-up .7s cubic-bezier(.22,1,.36,1) forwards 1.2s}
    .avatar{width:4rem;height:4rem;border-radius:1rem;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-family:'Outfit',sans-serif;font-weight:700;font-size:1.2rem;background:linear-gradient(135deg,#6366f1,#8b5cf6,#a78bfa);box-shadow:0 8px 24px rgba(99,102,241,.35)}
    .user-info{min-width:0}
    .user-info h3{font-family:'Outfit',sans-serif;font-weight:700;font-size:1.05rem;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .user-info p{color:#64748b;font-size:.875rem;margin-top:.15rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .plan-badge{margin-left:auto;flex-shrink:0;padding:.25rem .75rem;border-radius:99px;font-size:.75rem;font-weight:600;color:var(--brand-700);background:var(--brand-100);border:1px solid var(--brand-200)}
    .divider{height:1px;background:linear-gradient(90deg,transparent,#e2e8f0,transparent);margin:1.25rem 0}
    .row{display:flex;align-items:center;gap:.75rem;font-size:.875rem;color:#475569}
    .row+.row{margin-top:.75rem}
    .row-icon{width:2rem;height:2rem;border-radius:.5rem;flex-shrink:0;display:flex;align-items:center;justify-content:center}
    .row-icon.rose{background:#fff1f2}
    .row-icon.amber{background:#fffbeb}
    .row span{font-weight:500}
    .badge-muted{color:#94a3b8;margin-left:auto;font-size:.75rem}
    .badge-amber{color:#b45309;font-weight:600;margin-left:auto;font-size:.75rem}
    .entity-list{list-style:none;margin-top:.4rem}
    .entity-list li{display:flex;align-items:center;gap:.5rem;padding:.3rem 0;font-size:.875rem;color:#64748b}
    .entity-list li::before{content:'';display:block;width:.4rem;height:.4rem;border-radius:50%;background:var(--brand-400);flex-shrink:0}
    .entity-list li strong{color:#334155}
    .panels-wrap{width:100%;max-width:32rem;display:flex;flex-direction:column;gap:.75rem;opacity:0;animation:fade-up .6s ease forwards 1.5s}
    .panel-card{padding:1.25rem}
    .panel-header{display:flex;align-items:center;gap:.6rem;cursor:pointer;user-select:none}
    .panel-header:hover .panel-title{color:var(--brand-600)}
    .panel-title{font-family:'Outfit',sans-serif;font-weight:600;font-size:.93rem;color:#1e293b;flex:1}
    .tag{display:inline-flex;align-items:center;background:var(--brand-100);color:var(--brand-700);font-size:.72rem;padding:.15rem .55rem;border-radius:.3rem;font-weight:600;letter-spacing:.01em}
    .tag.emerald{background:#d1fae5;color:#065f46}
    .chevron{width:1.1rem;height:1.1rem;flex-shrink:0;color:#94a3b8;transition:transform .3s cubic-bezier(.4,0,.2,1),color .2s}
    .panel-card.open .chevron{transform:rotate(180deg);color:var(--brand-500)}
    .panel-body{overflow:hidden;max-height:0;transition:max-height .4s cubic-bezier(.4,0,.2,1),opacity .3s ease;opacity:0}
    .panel-card.open .panel-body{max-height:700px;opacity:1;overflow-x:auto}
    .panel-note{color:#64748b;font-size:.82rem;margin-bottom:.75rem;line-height:1.6;margin-top:.85rem}
    .panel-note code{background:rgba(99,102,241,.08);color:#4338ca;padding:.1rem .35rem;border-radius:.3rem;font-size:.78rem;font-family:'JetBrains Mono','Fira Code','Menlo',monospace}
    pre{background:#0f172a;border:1px solid #1e293b;border-radius:.6rem;padding:.9rem 1rem;font-size:.78rem;line-height:1.65;overflow-x:auto;white-space:pre;color:#e2e8f0;font-family:'JetBrains Mono','Fira Code','Menlo',monospace}
    #cdPre{max-height:420px;overflow-y:auto}
    pre .cmd-line{display:block}
    pre .cmd-line.first-line::before{content:'$ ';color:#818cf8;font-weight:700;-webkit-user-select:none;user-select:none}
    pre .cmd-gap{display:block;height:.6rem}
    .copy-row{display:flex;justify-content:flex-end;margin:.65rem 0 .5rem}
    .copy-btn{background:#6366f1;color:#fff;border:none;border-radius:.6rem;padding:.35rem .85rem;font-size:.8rem;cursor:pointer;font-family:'Outfit',sans-serif;font-weight:600;transition:background-color .3s ease,box-shadow .3s ease,transform .1s;box-shadow:0 4px 12px rgba(99,102,241,.3);white-space:nowrap}
    .copy-btn:hover{background:#4f46e5;transform:translateY(-1px)}
    .copy-btn.copied{background:#10b981 !important;box-shadow:0 4px 12px rgba(16,185,129,.4)}
    .openclaw-footnote{width:100%;max-width:32rem;margin-top:.85rem;text-align:center;font-size:.78rem;color:#94a3b8;opacity:0;animation:fade-up .5s ease forwards 1.75s}
    .openclaw-footnote strong{color:#64748b;font-weight:500}
    .wave{position:fixed;bottom:0;left:0;right:0;pointer-events:none}.wave svg{width:100%;display:block}
  </style>
</head>
<body>
<div class="orbs"><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="orb orb-3"></div><div class="orb orb-4"></div><div class="orb orb-5"></div></div>
<div class="grid-overlay"></div>
<main>

  <div class="brand">
    <div class="brand-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    </div>
    <span class="brand-name">SuiteCRM MCP</span>
  </div>

  <div class="checkmark-wrap">
    <div class="ring-pulse ring-1"></div><div class="ring-pulse ring-2"></div>
    <div class="check-circle">
      <svg viewBox="0 0 50 50" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
        <path class="check-path" d="M10 26 L20 36 L40 16"/>
      </svg>
    </div>
  </div>

  <div class="heading-block">
    <h1>You're authenticated!</h1>
    <p>Signed in as <strong id="emailDisplay"></strong>. <span class="heading-ready">Setup commands are ready below.</span></p>
  </div>

  <div class="glass-card user-card">
    <div style="display:flex;align-items:center;gap:1.25rem;margin-bottom:1.5rem">
      <div class="avatar" id="avatarEl"></div>
      <div class="user-info"><h3 id="userNameEl"></h3><p id="userEmailEl"></p></div>
      <span class="plan-badge">Gateway</span>
    </div>
    <div class="divider"></div>
    <div class="row">
      <div class="row-icon rose">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <span>API Key Expires</span>
      <span class="badge-amber">in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</span>
    </div>
    <div class="row" style="margin-top:.75rem;align-items:flex-start">
      <div class="row-icon amber" style="margin-top:.2rem">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-4 0v2"/><path d="M8 7V5a2 2 0 0 0-4 0v2"/></svg>
      </div>
      <div><span style="font-weight:500">Entity Access</span><ul class="entity-list" id="entityListEl"></ul></div>
    </div>

  </div>

  <div class="panels-wrap">
    <div class="panel-card glass-card open" id="panelCC">
      <div class="panel-header" onclick="togglePanel('panelCC')">
        <span class="tag">Claude Code</span>
        <span class="panel-title">Terminal setup</span>
        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="panel-body">
        <p class="panel-note">Open your terminal (macOS: <strong>Terminal</strong> or <strong>iTerm</strong> / Windows: <strong>PowerShell</strong> or <strong>Command Prompt</strong>) and paste:</p>
        <div class="copy-row"><button class="copy-btn" onclick="event.stopPropagation();copyCC(this)">Copy</button></div>
        <pre id="ccPre"></pre>
      </div>
    </div>
    <div class="panel-card glass-card" id="panelCD">
      <div class="panel-header" onclick="togglePanel('panelCD')">
        <span class="tag emerald">Claude Desktop</span>
        <span class="panel-title">JSON config</span>
        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="panel-body">
        <p class="panel-note">Add to your Claude Desktop config file, then fully quit and reopen Claude Desktop.<br><strong>macOS:</strong> <code>~/Library/Application Support/Claude/claude_desktop_config.json</code><br><strong>Windows:</strong> <code>%APPDATA%\\Claude\\claude_desktop_config.json</code></p>
        <div class="copy-row"><button class="copy-btn" onclick="event.stopPropagation();copyEl('cdPre',this)">Copy</button></div>
        <pre id="cdPre"></pre>
      </div>
    </div>
  </div>

  <p class="openclaw-footnote"><strong>OpenClaw users:</strong> you're all set - your bridge is connected or will be within seconds.</p>

</main>
<div class="wave">
  <svg viewBox="0 0 1440 120" preserveAspectRatio="none">
    <defs><linearGradient id="waveGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="rgba(99,102,241,0.05)"/><stop offset="50%" stop-color="rgba(139,92,246,0.08)"/><stop offset="100%" stop-color="rgba(16,185,129,0.05)"/></linearGradient></defs>
    <path d="M0,60 C360,120 720,0 1080,60 C1260,90 1380,40 1440,60 L1440,120 L0,120 Z" fill="url(#waveGrad)"/>
  </svg>
</div>
<script>
const GW_EMAIL    = ${JSON.stringify(email)};
const GW_APIKEY   = ${JSON.stringify(apiKey)};
const GW_BASE     = ${JSON.stringify(GATEWAY_URL)};
const GW_ENTITIES = ${JSON.stringify(entities.map(({code,label})=>({code,label})))};

function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

var _ccRawText = '';

(function init(){
  const namePart = GW_EMAIL.split('@')[0];
  document.getElementById('emailDisplay').textContent = GW_EMAIL;
  document.getElementById('avatarEl').textContent     = namePart.slice(0,2).toUpperCase();
  document.getElementById('userNameEl').textContent   = namePart;
  document.getElementById('userEmailEl').textContent  = GW_EMAIL;

  const ul = document.getElementById('entityListEl');
  GW_ENTITIES.forEach(({code,label})=>{
    const li=document.createElement('li');
    li.innerHTML='<strong>'+escHtml(code)+'</strong> - '+escHtml(label);
    ul.appendChild(li);
  });

  // Build Claude Code commands
  const rawParts = [];
  const pre = document.getElementById('ccPre');
  pre.innerHTML = '';

  GW_ENTITIES.forEach(({code,label},i)=>{
    const url  = code==='default' ? GW_BASE+'/sse' : GW_BASE+'/'+code+'/sse';
    const name = code==='default' ? 'suitecrm'     : 'suitecrm_'+code;
    const lines = [
      'claude mcp add --transport sse '+name+' \\\\',
      '  '+url+' \\\\',
      '  --header "Authorization: Bearer '+GW_APIKEY+'"'
    ];

    if(i > 0){
      rawParts.push('');
      const gap=document.createElement('span');
      gap.className='cmd-gap';
      pre.appendChild(gap);
    }

    lines.forEach((text,j)=>{
      rawParts.push(text);
      const span=document.createElement('span');
      span.className = j===0 ? 'cmd-line first-line' : 'cmd-line';
      span.textContent = text;
      pre.appendChild(span);
    });
  });

  _ccRawText = rawParts.filter(l=>l!=='').join('\\n');

  // Claude Desktop JSON
  const json={mcpServers:Object.fromEntries(GW_ENTITIES.map(({code})=>{
    const url  = code==='default' ? GW_BASE+'/sse' : GW_BASE+'/'+code+'/sse';
    const name = code==='default' ? 'suitecrm'     : 'suitecrm_'+code;
    return [name,{type:'sse',url,headers:{Authorization:'Bearer '+GW_APIKEY}}];
  }))};
  document.getElementById('cdPre').textContent = JSON.stringify(json,null,2);
})();

function togglePanel(id){
  document.getElementById(id).classList.toggle('open');
}

function copyCC(btn){
  navigator.clipboard.writeText(_ccRawText).then(()=>{
    btn.innerHTML='&#10003;&nbsp;Copied';btn.classList.add('copied');
    setTimeout(()=>{btn.innerHTML='Copy';btn.classList.remove('copied');},2000);
  });
}

function copyEl(id,btn){
  navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>{
    btn.innerHTML='&#10003;&nbsp;Copied';btn.classList.add('copied');
    setTimeout(()=>{btn.innerHTML='Copy';btn.classList.remove('copied');},2000);
  });
}
</script>
</body>
</html>`);

  } catch (err) {
    logger.error({ err: err.message }, 'callback_error');
    metricLogins.inc({ result: 'error' });
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:40px">
        <h2>Something went wrong</h2>
        <p>${escHtml(err.message)}</p>
        <p>Please close this tab and try again.</p>
      </body></html>`);
  }
});

// ========================================================================
// SECURE BRIDGE AUTH ENDPOINTS (v4.x)
// ========================================================================

const logoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many logout requests' },
});

const bridgeStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bridge session requests, try again later' },
});

const bridgePollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many poll requests, slow down' },
});

// POST /auth/bridge/start -> creates nonce session for bridge
app.post('/auth/bridge/start', bridgeStartLimiter, (req, res) => {
  const { linux_user } = req.body;
  if (!linux_user || typeof linux_user !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid linux_user' });
  }

  const nonce        = randomBytes(32).toString('hex');
  const clientSecret = randomBytes(32).toString('hex');

  const bridgeSessions = cleanExpiredBridgeSessions(loadBridgeSessions());
  bridgeSessions[nonce] = {
    linuxUser:    linux_user,
    clientSecret,
    createdAt:    Date.now(),
    expiresAt:    Date.now() + BRIDGE_SESSION_TTL_MS,
    status:       'pending',
  };
  saveBridgeSessions(bridgeSessions);

  const loginUrl = `${GATEWAY_URL}/auth/login?nonce=${nonce}`;
  logger.info({ linuxUser: linux_user, nonce: nonce.slice(0, 16) }, 'bridge_session_started');
  metricBridgeSessions.inc({ event: 'started' });

  res.json({ nonce, client_secret: clientSecret, login_url: loginUrl });
});

// GET /auth/bridge/poll/:nonce -> bridge polls this with X-Bridge-Secret
app.get('/auth/bridge/poll/:nonce', bridgePollLimiter, (req, res) => {
  const nonce        = qs(req.params.nonce);
  const clientSecret = qs(req.headers['x-bridge-secret']);

  if (!clientSecret) {
    return res.status(401).json({ error: 'Missing X-Bridge-Secret header' });
  }
  if (!NONCE_RE.test(nonce)) {
    return res.status(400).json({ error: 'Invalid nonce format' });
  }

  const bridgeSessions = cleanExpiredBridgeSessions(loadBridgeSessions());
  const session        = Object.hasOwn(bridgeSessions, nonce) ? bridgeSessions[nonce] : null;

  if (!session) return res.status(404).json({ status: 'not_found' });

  if (session.expiresAt < Date.now()) {
    delete bridgeSessions[nonce];
    saveBridgeSessions(bridgeSessions);
    metricBridgeSessions.inc({ event: 'expired' });
    return res.status(410).json({ status: 'expired' });
  }

  if (session.clientSecret !== clientSecret) {
    return res.status(403).json({ error: 'Invalid client secret' });
  }

  if (session.status === 'ready' && session.apiKey) {
    // Token was already written to sessions.json during the OAuth callback
    // Only write as fallback if somehow missing
    const sessions = cleanExpiredSessions(loadSessions());
    if (!sessions[session.apiKey]) {
      sessions[session.apiKey] = {
        sub:       session.sub || 'bridge-user',
        email:     session.email || session.linuxUser,
        linuxUser: session.linuxUser,
        groups:    session.groups || [],
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      saveSessions(sessions);
    }

    const apiKey = session.apiKey;
    delete bridgeSessions[nonce];
    saveBridgeSessions(bridgeSessions);
    logger.info({ linuxUser: session.linuxUser }, 'bridge_session_completed');
    metricBridgeSessions.inc({ event: 'completed' });

    return res.json({ status: 'ready', api_key: apiKey });
  }

  res.json({ status: 'pending' });
});


// POST /auth/logout -> invalidate session
app.post('/auth/logout', logoutLimiter, (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '')
    || qs(req.headers['x-gateway-token']);
  const sessions = loadSessions();
  if (API_KEY_RE.test(token) && Object.hasOwn(sessions, token)) {
    delete sessions[token];
    saveSessions(sessions);
  }
  res.json({ success: true });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'suitecrm-mcp-auth' }));

const PORT = parseInt(process.env.PORT || '3100', 10);
const BIND_HOST = (process.env.BIND_HOST || '127.0.0.1').trim();
app.listen(PORT, BIND_HOST, () => {
  logger.info({ host: BIND_HOST, port: PORT }, 'listening');
});

// Purge stale bridge-session nonces every hour. Nonces are also cleaned on
// each /auth/start and /auth/poll call, but periodic cleanup covers cases where
// users abandon the flow without polling.
setInterval(() => {
  const bs = loadBridgeSessions();
  const before = Object.keys(bs).length;
  cleanExpiredBridgeSessions(bs);
  const removed = before - Object.keys(bs).length;
  if (removed > 0) {
    saveBridgeSessions(bs);
    logger.info({ removed }, 'bridge_sessions_purged');
  }
}, 60 * 60 * 1000).unref();

// Purge expired gateway tokens from sessions.json every hour. Also runs once on
// startup so stale tokens from a prior run are cleared immediately.
try {
  const sessions = loadSessions();
  const before = Object.keys(sessions).length;
  cleanExpiredSessions(sessions);
  const removed = before - Object.keys(sessions).length;
  if (removed > 0) { saveSessions(sessions); logger.info({ removed }, 'gateway_sessions_purged'); }
} catch (err) {
  logger.warn({ err: err.message }, 'startup gateway_sessions_purge failed — continuing');
}
setInterval(() => {
  const sessions = loadSessions();
  const before = Object.keys(sessions).length;
  cleanExpiredSessions(sessions);
  const removed = before - Object.keys(sessions).length;
  if (removed > 0) {
    saveSessions(sessions);
    logger.info({ removed }, 'gateway_sessions_purged');
  }
}, 60 * 60 * 1000).unref();

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9091', 10);
const METRICS_BIND = (process.env.METRICS_BIND || '127.0.0.1').trim();
http.createServer(async (req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
    res.end(await metricsRegistry.metrics());
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(METRICS_PORT, METRICS_BIND, () => {
  logger.info({ host: METRICS_BIND, port: METRICS_PORT }, 'metrics_listening');
});
