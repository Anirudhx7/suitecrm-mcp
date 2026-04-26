
/**
 * SuiteCRM MCP Gateway Server (index.mjs)
 * Per-entity server (one process per entity)
 * Auth: gateway session tokens (issued by auth.mjs, stored in sessions.json)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import https from 'https';
import http from 'http';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import pino from 'pino';

const REQUIRED = ['SUITECRM_ENDPOINT', 'SUITECRM_PREFIX', 'PORT', 'AUTH0_DOMAIN', 'AUTH0_AUDIENCE'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error(`Missing required env vars: ${missing.join(', ')}`); process.exit(1); }

const ENDPOINT    = process.env.SUITECRM_ENDPOINT.trim();
const PREFIX      = process.env.SUITECRM_PREFIX.trim();
const logger = pino({
  base: { entity: PREFIX },
  timestamp: pino.stdTimeFunctions.isoTime,
});
const PORT        = parseInt(process.env.PORT, 10);
const CODE        = (process.env.SUITECRM_CODE || '').trim();
const AUTH0_DOMAIN   = process.env.AUTH0_DOMAIN.trim();
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE.trim();
const REQUIRED_GROUP = (process.env.REQUIRED_GROUP || '').trim();
const PROFILES_FILE  = '/etc/suitecrm-mcp/user-profiles.json';
const NS             = AUTH0_AUDIENCE + '/';
const TLS_OK         = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';

const METRICS_PORT  = parseInt(process.env.METRICS_PORT || '9090', 10);
const METRICS_BIND  = (process.env.METRICS_BIND || '127.0.0.1').trim();
const CRM_REQUEST_TIMEOUT_MS    = parseInt(process.env.CRM_TIMEOUT_MS              || '30000', 10);
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD   || '5',     10);
const CIRCUIT_BREAKER_RESET_MS  = parseInt(process.env.CIRCUIT_BREAKER_RESET_MS    || '60000', 10);

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ entity: PREFIX });
collectDefaultMetrics({ register: metricsRegistry });

const metricActiveConnections = new Gauge({
  name: 'suitecrm_mcp_active_connections', help: 'Active SSE connections',
  labelNames: ['entity'], registers: [metricsRegistry],
});
const metricConnections = new Counter({
  name: 'suitecrm_mcp_connections_total', help: 'Total SSE connections established',
  labelNames: ['entity'], registers: [metricsRegistry],
});
const metricToolCalls = new Counter({
  name: 'suitecrm_mcp_tool_calls_total', help: 'Total tool calls',
  labelNames: ['entity', 'tool', 'status'], registers: [metricsRegistry],
});
const metricToolDuration = new Histogram({
  name: 'suitecrm_mcp_tool_duration_seconds', help: 'Tool call duration in seconds',
  labelNames: ['entity', 'tool'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});
const metricCrmApiDuration = new Histogram({
  name: 'suitecrm_mcp_crm_api_duration_seconds', help: 'CRM REST API call duration in seconds',
  labelNames: ['entity', 'method'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});
const metricSessionRenewals = new Counter({
  name: 'suitecrm_mcp_session_renewals_total', help: 'CRM session renewals',
  labelNames: ['entity'], registers: [metricsRegistry],
});
const metricAuthFailures = new Counter({
  name: 'suitecrm_mcp_auth_failures_total', help: 'Authentication failures',
  labelNames: ['entity'], registers: [metricsRegistry],
});
const metricCircuitBreakerState = new Gauge({
  name: 'suitecrm_mcp_circuit_breaker_state', help: 'Circuit breaker state (0=closed,1=half-open,2=open)',
  labelNames: ['entity'], registers: [metricsRegistry],
});
const metricCircuitBreakerOpenings = new Counter({
  name: 'suitecrm_mcp_circuit_breaker_openings_total', help: 'Circuit breaker openings',
  labelNames: ['entity'], registers: [metricsRegistry],
});
const metricRateLimited = new Counter({
  name: 'suitecrm_mcp_rate_limited_total', help: 'Requests rejected by rate limiter',
  labelNames: ['entity', 'route'], registers: [metricsRegistry],
});
const metricConnectionRejected = new Counter({
  name: 'suitecrm_mcp_connection_rejected_total', help: 'SSE connections rejected at capacity cap',
  labelNames: ['entity'], registers: [metricsRegistry],
});
const metricCrmErrors = new Counter({
  name: 'suitecrm_mcp_crm_errors_total', help: 'CRM REST API errors by error code',
  labelNames: ['entity', 'method', 'crm_code'], registers: [metricsRegistry],
});
const NETWORK_ERRS = new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','ECONNABORTED']);
const metricCrmSessionsCached = new Gauge({
  name: 'suitecrm_mcp_crm_sessions_cached', help: 'In-memory CRM sessions cached',
  labelNames: ['entity'], registers: [metricsRegistry],
});
new Gauge({
  name: 'suitecrm_mcp_profiles_configured',
  help: 'Users with a CRM profile configured for this entity',
  labelNames: ['entity'], registers: [metricsRegistry],
  collect() {
    this.reset();
    const profiles = loadProfiles();
    let count = 0;
    for (const p of Object.values(profiles)) {
      if (p.entities?.[CODE]) count++;
    }
    this.set({ entity: PREFIX }, count);
  },
});
new Gauge({
  name: 'suitecrm_mcp_gateway_sessions_active',
  help: 'Users with a valid non-expired gateway API session for this entity',
  labelNames: ['entity'], registers: [metricsRegistry],
  collect() {
    this.reset();
    const sessions = loadSessions();
    const profiles = loadProfiles();
    const now = Date.now();
    const activeSubs = new Set(
      Object.values(sessions).filter(s => s.expiresAt > now).map(s => s.sub)
    );
    let count = 0;
    for (const [sub, p] of Object.entries(profiles)) {
      if (p.entities?.[CODE] && activeSubs.has(sub)) count++;
    }
    this.set({ entity: PREFIX }, count);
  },
});
new Gauge({
  name: 'suitecrm_mcp_user_crm_session_active',
  help: 'Whether user has active in-memory CRM session (1=yes 0=no)',
  labelNames: ['sub', 'email', 'entity', 'crm_user'], registers: [metricsRegistry],
  collect() {
    this.reset();
    const profiles = loadProfiles();
    for (const [sub, profile] of Object.entries(profiles)) {
      const creds = profile.entities?.[CODE];
      if (!creds) continue;
      this.set({
        sub,
        email: profile.email || sub,
        entity: PREFIX,
        crm_user: creds.user || '',
      }, crmSessions.has(`${sub}:${CODE}`) ? 1 : 0);
    }
  },
});
new Gauge({
  name: 'suitecrm_mcp_user_gateway_session_active',
  help: 'Whether user has a valid non-expired gateway session token (1=yes 0=no)',
  labelNames: ['sub', 'email'], registers: [metricsRegistry],
  collect() {
    this.reset();
    const sessions = loadSessions();
    const profiles = loadProfiles();
    const now = Date.now();
    const subBest = {};
    for (const sess of Object.values(sessions)) {
      if (!profiles[sess.sub]?.entities?.[CODE]) continue;
      subBest[sess.sub] = subBest[sess.sub] || (sess.expiresAt > now ? 1 : 0);
    }
    for (const [sub, active] of Object.entries(subBest)) {
      this.set({ sub, email: profiles[sub]?.email || sub }, active);
    }
  },
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
const circuitBreaker = {
  state: 'CLOSED', failures: 0, lastFailure: 0,
  isOpen() {
    if (this.state === 'CLOSED') return false;
    if (this.state === 'HALF_OPEN') return true; // probe in-flight; block all other requests
    // OPEN: check reset window
    if (Date.now() - this.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
      this.state = 'HALF_OPEN';
      metricCircuitBreakerState.set({ entity: PREFIX }, 1);
      logger.warn({ state: 'HALF_OPEN' }, 'circuit_breaker_state');
      return false; // let exactly one probe through
    }
    return true;
  },
  recordSuccess() {
    if (this.state !== 'CLOSED') logger.info({ state: 'CLOSED' }, 'circuit_breaker_state');
    this.state = 'CLOSED'; this.failures = 0;
    metricCircuitBreakerState.set({ entity: PREFIX }, 0);
  },
  recordFailure() {
    this.failures++; this.lastFailure = Date.now();
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      metricCircuitBreakerState.set({ entity: PREFIX }, 2);
      metricCircuitBreakerOpenings.inc({ entity: PREFIX });
      logger.warn({ state: 'OPEN', failures: this.failures }, 'circuit_breaker_state');
    } else if (this.failures >= CIRCUIT_BREAKER_THRESHOLD && this.state !== 'OPEN') {
      this.state = 'OPEN';
      metricCircuitBreakerState.set({ entity: PREFIX }, 2);
      metricCircuitBreakerOpenings.inc({ entity: PREFIX });
      logger.warn({ state: 'OPEN', failures: this.failures }, 'circuit_breaker_state');
    }
  },
};

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const transports = new Map();
const crmSessions = new Map();
const crmSessionAges = new Map();
const connCreds = new Map();
const subBySid = new Map();
const connLoggers = new Map();

const CRM_SESSION_TTL = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - CRM_SESSION_TTL;
  for (const [key, at] of crmSessionAges.entries()) {
    if (at < cutoff) {
      crmSessions.delete(key);
      crmSessionAges.delete(key);
    }
  }
  metricCrmSessionsCached.set({ entity: PREFIX }, crmSessions.size);
}, 30 * 60 * 1000).unref();

function loadProfiles() {
  try { return JSON.parse(readFileSync(PROFILES_FILE, 'utf8')); }
  catch { return {}; }
}

// Redact potentially-PII field values from audit log entries.
// Keeps structural keys (so logs show which fields were queried) but
// removes values that may contain names, emails, or business-sensitive data.
function redactAuditArgs(args) {
  const safe = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'name_value_list' || k === 'search_params' || k === 'fields') {
      safe[k] = (typeof v === 'object' && v !== null)
        ? Object.fromEntries(Object.keys(v).map(fk => [fk, '[redacted]']))
        : '[redacted]';
    } else if (k === 'query' || k === 'search_query' || k === 'search_string') {
      safe[k] = '[redacted]';
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

// 2-second read cache. In Docker multi-container deployments, auth.mjs writes
// sessions.json on a different container's filesystem - the cache means an entity
// gateway may lag up to 2s after a new token is issued before it accepts it.
let _sessionsCache = null;
let _sessionsCacheAt = 0;
function loadSessions() {
  const now = Date.now();
  if (!_sessionsCache || now - _sessionsCacheAt > 2000) {
    try { _sessionsCache = JSON.parse(readFileSync('/etc/suitecrm-mcp/sessions.json', 'utf8')); }
    catch { _sessionsCache = {}; }
    _sessionsCacheAt = now;
  }
  return _sessionsCache;
}

async function jwtMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Bearer token required' });

  try {
    const sessions = loadSessions();
    const session = sessions[token];
    if (session) {
      if (session.expiresAt < Date.now()) {
        metricAuthFailures.inc({ entity: PREFIX });
        logger.warn({ reason: 'session_expired', sub: session.sub }, 'auth_failed');
        return res.status(401).json({ error: 'Session expired' });
      }
      req.auth = {
        sub: session.sub,
        email: session.email,
        [`${NS}samaccountname`]: session.email,
        [`${NS}groups`]: session.groups || [],
      };
      return next();
    }
  } catch {}

  metricAuthFailures.inc({ entity: PREFIX });
  logger.warn({ reason: 'invalid_token' }, 'auth_failed');
  return res.status(401).json({ error: 'Invalid token' });
}

function profileMiddleware(req, res, next) {
  const profiles = loadProfiles();
  const profile = profiles[req.auth.sub];
  if (!profile) {
    return res.status(403).json({
      error: 'No CRM profile',
      sub: req.auth.sub,
      fix: `Run: mcp-admin add --sub "${req.auth.sub}" --entity ${CODE} --user <u> --pass <p>`,
    });
  }
  req.crmProfile = profile;
  next();
}

function groupAccessMiddleware(req, res, next) {
  if (REQUIRED_GROUP) {
    const userGroups = req.auth[`${NS}groups`] || [];
    const hasGroup = userGroups.some(g => g.toLowerCase() === REQUIRED_GROUP.toLowerCase());
    if (!hasGroup) {
      return res.status(403).json({
        error: `Not in group "${REQUIRED_GROUP}"`,
        your_groups: userGroups,
      });
    }
  }
  const creds = req.crmProfile?.entities?.[CODE];
  if (!creds?.user || !creds?.pass) {
    return res.status(403).json({
      error: `No CRM credentials for ${CODE}`,
      fix: `Run: mcp-admin add --sub "${req.auth.sub}" --entity ${CODE} --user <u> --pass <p>`,
    });
  }
  req.crmCreds = creds;
  next();
}

function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: TLS_OK,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`Non-JSON: ${raw.slice(0, 300)}`)); }
      });
    });
    req.setTimeout(CRM_REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function rawCall(method, restData) {
  const end = metricCrmApiDuration.startTimer({ entity: PREFIX, method });
  try {
    const r = await postForm(ENDPOINT, {
      method,
      input_type: 'JSON',
      response_type: 'JSON',
      rest_data: JSON.stringify(restData),
    });
    if (r && typeof r.number === 'number' && r.number !== 0) {
      const e = new Error(r.name || r.description || `CRM error ${r.number}`);
      e.code = r.number;
      end(); throw e;
    }
    end(); return r;
  } catch (err) {
    end();
    const crmCode = typeof err.code === 'number'
      ? String(err.code)
      : (NETWORK_ERRS.has(err.code) || err.message?.includes('Timeout') ? 'network' : 'unknown');
    metricCrmErrors.inc({ entity: PREFIX, method, crm_code: crmCode });
    throw err;
  }
}

async function crmLogin(user, pass) {
  const r = await rawCall('login', {
    user_auth: {
      user_name: user,
      password: createHash('md5').update(pass).digest('hex'),
    },
    application_name: 'SuiteCRM-MCP',
    name_value_list: [],
  });
  if (!r.id || r.id === 0 || r.id === '0') {
    throw new Error(`Login failed for ${user}`);
  }
  return r.id;
}

async function ensureCrmSession(sid) {
  const sub = subBySid.get(sid) || sid;
  const key = `${sub}:${CODE}`;
  if (crmSessions.has(key)) return crmSessions.get(key);
  const creds = connCreds.get(sid);
  if (!creds) throw new Error('No credentials');
  const crmSid = await crmLogin(creds.user, creds.pass);
  crmSessions.set(key, crmSid);
  crmSessionAges.set(key, Date.now());
  metricCrmSessionsCached.set({ entity: PREFIX }, crmSessions.size);
  return crmSid;
}

async function crmCall(sid, method, params) {
  if (circuitBreaker.isOpen())
    throw new Error(`Circuit breaker open - CRM unavailable (${circuitBreaker.failures} consecutive failures)`);

  let crmSid;
  try { crmSid = await ensureCrmSession(sid); }
  catch (err) { circuitBreaker.recordFailure(); throw err; }

  try {
    const result = await rawCall(method, { session: crmSid, ...params });
    circuitBreaker.recordSuccess();
    return result;
  } catch (err) {
    if (err.code === 11) {
      const _cLog = connLoggers.get(sid) || logger;
      _cLog.info({ sid }, 'crm_session_expired_renewing');
      metricSessionRenewals.inc({ entity: PREFIX });
      const sub = subBySid.get(sid) || sid;
      crmSessions.delete(`${sub}:${CODE}`);
      crmSessionAges.delete(`${sub}:${CODE}`);
      metricCrmSessionsCached.set({ entity: PREFIX }, crmSessions.size);
      try {
        crmSid = await ensureCrmSession(sid);
        const result = await rawCall(method, { session: crmSid, ...params });
        circuitBreaker.recordSuccess();
        return result;
      } catch (retryErr) { circuitBreaker.recordFailure(); throw retryErr; }
    }
    circuitBreaker.recordFailure(); throw err;
  }
}

function flatNvl(nvl) {
  if (!nvl || typeof nvl !== 'object') return {};
  const out = {};
  for (const k of Object.keys(nvl)) {
    const v = nvl[k];
    out[k] = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  }
  return out;
}

function flatList(el) {
  return (el || []).map(e => flatNvl(e.name_value_list || e));
}

function toNvl(obj) {
  return Object.entries(obj).map(([n, v]) => ({ name: n, value: String(v ?? '') }));
}

const MODULE_RE    = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const IDENT_RE     = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_LEN    = 2000;
const MAX_ORDER_BY_LEN = 200;
const MAX_RESULTS_CAP  = 100;
const MAX_FIELDS       = 50;

function validateModule(module) {
  if (!module || !MODULE_RE.test(module)) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid module name: ${module}`);
  }
}

function validateId(id) {
  if (!id || !UUID_RE.test(String(id))) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid record ID (expected UUID): ${id}`);
  }
}

function validateIdent(name, label = 'field') {
  if (!name || !IDENT_RE.test(String(name))) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${label} name: ${name}`);
  }
}

function validateFieldList(fields) {
  if (!Array.isArray(fields)) return;
  if (fields.length > MAX_FIELDS) {
    throw new McpError(ErrorCode.InvalidParams, `Too many fields (max ${MAX_FIELDS})`);
  }
  for (const f of fields) validateIdent(f, 'field');
}

function validateQuery(query) {
  if (query == null) return;
  if (typeof query !== 'string') throw new McpError(ErrorCode.InvalidParams, 'query must be a string');
  if (query.length > MAX_QUERY_LEN) throw new McpError(ErrorCode.InvalidParams, `Query exceeds maximum length of ${MAX_QUERY_LEN} characters`);
}

function validateOrderBy(order_by) {
  if (order_by == null) return;
  if (typeof order_by !== 'string') throw new McpError(ErrorCode.InvalidParams, 'order_by must be a string');
  if (order_by.length > MAX_ORDER_BY_LEN) throw new McpError(ErrorCode.InvalidParams, `order_by exceeds maximum length of ${MAX_ORDER_BY_LEN} characters`);
}

function coerceNumeric(val, defaultVal, min, max) {
  const n = Number.isInteger(val) ? val : parseInt(val, 10);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.max(min, Math.min(max, n));
}

async function searchRecords(sid, { module, query='', fields=[], max_results=20, offset=0, order_by='' }) {
  validateModule(module);
  validateQuery(query);
  validateOrderBy(order_by);
  validateFieldList(fields);
  const safeMax    = coerceNumeric(max_results, 20, 1, MAX_RESULTS_CAP);
  const safeOffset = coerceNumeric(offset, 0, 0, 1_000_000);
  const r = await crmCall(sid, 'get_entry_list', {
    module_name: module,
    query,
    order_by,
    offset: safeOffset,
    select_fields: fields,
    link_name_to_fields_array: [],
    max_results: safeMax,
    deleted: 0,
    favorites: false,
  });
  return {
    module,
    records: flatList(r.entry_list),
    result_count: r.result_count || 0,
    total_count: parseInt(r.total_count || '0', 10),
    next_offset: r.next_offset || 0,
  };
}

async function searchText(sid, { search_string, modules=['Accounts','Contacts','Leads'], max_results=10 }) {
  validateQuery(search_string);
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'modules must be a non-empty array');
  }
  if (modules.length > 20) {
    throw new McpError(ErrorCode.InvalidParams, 'modules array exceeds maximum of 20 entries');
  }
  for (const m of modules) validateModule(m);
  const safeMax = coerceNumeric(max_results, 10, 1, MAX_RESULTS_CAP);
  const r = await crmCall(sid, 'search_by_module', {
    search_string,
    modules,
    offset: 0,
    max_results: safeMax,
    assigned_user_id: '',
    select_fields: [],
    unified_search_only: false,
    favorites: false,
  });
  const out = {};
  for (const e of (r.entry_list || [])) {
    out[e.name] = (e.records || []).map(rec => {
      const flat = {};
      for (const k of Object.keys(rec)) {
        const v = rec[k];
        flat[k] = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
      }
      return flat;
    });
  }
  return out;
}

async function getRecord(sid, { module, id, fields=[] }) {
  validateModule(module);
  validateId(id);
  validateFieldList(fields);
  const r = await crmCall(sid, 'get_entry', {
    module_name: module,
    id,
    select_fields: fields,
    link_name_to_fields_array: [],
    track_view: false,
  });
  const recs = flatList(r.entry_list);
  return recs.length ? recs[0] : null;
}

function validateFieldsObject(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new McpError(ErrorCode.InvalidParams, 'fields must be a non-null object');
  }
  const keys = Object.keys(fields);
  if (keys.length > MAX_FIELDS) {
    throw new McpError(ErrorCode.InvalidParams, `Too many fields (max ${MAX_FIELDS})`);
  }
  for (const k of keys) validateIdent(k, 'field');
}

async function createRecord(sid, { module, fields }) {
  validateModule(module);
  validateFieldsObject(fields);
  const r = await crmCall(sid, 'set_entry', {
    module_name: module,
    name_value_list: toNvl(fields),
  });
  return { id: r.id, module, created: true };
}

async function updateRecord(sid, { module, id, fields }) {
  validateModule(module);
  validateId(id);
  validateFieldsObject(fields);
  const r = await crmCall(sid, 'set_entry', {
    module_name: module,
    name_value_list: [{ name: 'id', value: id }, ...toNvl(fields)],
  });
  return { id: r.id, module, updated: true };
}

async function deleteRecord(sid, { module, id }) {
  validateModule(module);
  validateId(id);
  const r = await crmCall(sid, 'set_entry', {
    module_name: module,
    name_value_list: [
      { name: 'id', value: id },
      { name: 'deleted', value: '1' },
    ],
  });
  return { id: r.id, module, deleted: true };
}

async function countRecords(sid, { module, query='' }) {
  validateModule(module);
  validateQuery(query);
  const r = await crmCall(sid, 'get_entries_count', {
    module_name: module,
    query,
    deleted: 0,
  });
  return { module, count: parseInt(r.result_count || '0', 10) };
}

async function getRelationships(sid, { module, id, link_field, related_fields=[], max_results=20, offset=0 }) {
  validateModule(module);
  validateId(id);
  validateIdent(link_field, 'link_field');
  validateFieldList(related_fields);
  const safeMax    = coerceNumeric(max_results, 20, 1, MAX_RESULTS_CAP);
  const safeOffset = coerceNumeric(offset, 0, 0, 1_000_000);
  const r = await crmCall(sid, 'get_relationships', {
    module_name: module,
    module_id: id,
    link_field_name: link_field,
    related_module_query: '',
    related_fields,
    related_module_link_name_to_fields_array: [],
    deleted: 0,
    order_by: '',
    offset: safeOffset,
    limit: safeMax,
  });
  return {
    records: flatList(r.entry_list),
    count: (r.entry_list || []).length,
  };
}

async function linkRecords(sid, { module, id, link_field, related_ids }) {
  validateModule(module);
  validateId(id);
  validateIdent(link_field, 'link_field');
  const ids = Array.isArray(related_ids) ? related_ids : [related_ids];
  if (ids.length > 100) throw new McpError(ErrorCode.InvalidParams, 'Too many related_ids (max 100)');
  for (const rid of ids) validateId(rid);
  const r = await crmCall(sid, 'set_relationship', {
    module_name: module,
    module_id: id,
    link_field_name: link_field,
    related_ids: ids,
    name_value_list: [],
    delete: 0,
  });
  return { created: r.created, failed: r.failed };
}

async function unlinkRecords(sid, { module, id, link_field, related_ids }) {
  validateModule(module);
  validateId(id);
  validateIdent(link_field, 'link_field');
  const ids = Array.isArray(related_ids) ? related_ids : [related_ids];
  if (ids.length > 100) throw new McpError(ErrorCode.InvalidParams, 'Too many related_ids (max 100)');
  for (const rid of ids) validateId(rid);
  const r = await crmCall(sid, 'set_relationship', {
    module_name: module,
    module_id: id,
    link_field_name: link_field,
    related_ids: ids,
    name_value_list: [],
    delete: 1,
  });
  return { deleted: r.deleted, failed: r.failed };
}

async function getModuleFields(sid, { module }) {
  validateModule(module);
  const r = await crmCall(sid, 'get_module_fields', {
    module_name: module,
    fields: [],
  });
  return {
    module: r.module_name,
    table: r.table_name,
    fields: Object.values(r.module_fields || {}).map(f => ({
      name: f.name,
      type: f.type,
      label: f.label,
      required: f.required,
      options: f.options ? Object.keys(f.options) : undefined,
    })),
    relationships: (r.link_fields || []).map(l => ({
      name: l.name,
      related_module: l.module,
    })),
  };
}

async function listModules(sid) {
  const r = await crmCall(sid, 'get_available_modules', { filter: 'all' });
  return (r.modules || []).map(m => ({
    key: m.module_key,
    label: m.module_label,
  }));
}

async function serverInfo(sid) {
  const creds = connCreds.get(sid) || {};
  return {
    prefix: PREFIX,
    port: PORT,
    entity: CODE,
    endpoint: ENDPOINT,
    crm_user: creds.user || '?',
    auth: 'gateway-session',
    required_group: REQUIRED_GROUP,
    session_active: crmSessions.has(`${subBySid.get(sid) || sid}:${CODE}`),
    active_connections: transports.size,
    circuit_breaker: circuitBreaker.state.toLowerCase(),
  };
}

const TOOLS = [
  {
    name: `${PREFIX}_search`,
    description: 'Search records with SQL WHERE',
    inputSchema: {
      type: 'object',
      required: ['module'],
      properties: {
        module: { type: 'string' },
        query: { type: 'string' },
        fields: { type: 'array', items: { type: 'string' } },
        max_results: { type: 'number' },
        offset: { type: 'number' },
        order_by: { type: 'string' },
      },
    },
  },
  {
    name: `${PREFIX}_search_text`,
    description: 'Full-text search',
    inputSchema: {
      type: 'object',
      required: ['search_string'],
      properties: {
        search_string: { type: 'string' },
        modules: { type: 'array', items: { type: 'string' } },
        max_results: { type: 'number' },
      },
    },
  },
  {
    name: `${PREFIX}_get`,
    description: 'Get record by UUID',
    inputSchema: {
      type: 'object',
      required: ['module', 'id'],
      properties: {
        module: { type: 'string' },
        id: { type: 'string' },
        fields: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: `${PREFIX}_create`,
    description: 'Create record',
    inputSchema: {
      type: 'object',
      required: ['module', 'fields'],
      properties: {
        module: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
  {
    name: `${PREFIX}_update`,
    description: 'Update record',
    inputSchema: {
      type: 'object',
      required: ['module', 'id', 'fields'],
      properties: {
        module: { type: 'string' },
        id: { type: 'string' },
        fields: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
  {
    name: `${PREFIX}_delete`,
    description: 'Delete record',
    inputSchema: {
      type: 'object',
      required: ['module', 'id'],
      properties: {
        module: { type: 'string' },
        id: { type: 'string' },
      },
    },
  },
  {
    name: `${PREFIX}_count`,
    description: 'Count records',
    inputSchema: {
      type: 'object',
      required: ['module'],
      properties: {
        module: { type: 'string' },
        query: { type: 'string' },
      },
    },
  },
  {
    name: `${PREFIX}_get_relationships`,
    description: 'Get related records',
    inputSchema: {
      type: 'object',
      required: ['module', 'id', 'link_field'],
      properties: {
        module: { type: 'string' },
        id: { type: 'string' },
        link_field: { type: 'string' },
        related_fields: { type: 'array', items: { type: 'string' } },
        max_results: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: `${PREFIX}_link_records`,
    description: 'Link records',
    inputSchema: {
      type: 'object',
      required: ['module', 'id', 'link_field', 'related_ids'],
      properties: {
        module: { type: 'string' },
        id: { type: 'string' },
        link_field: { type: 'string' },
        related_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: `${PREFIX}_unlink_records`,
    description: 'Unlink records',
    inputSchema: {
      type: 'object',
      required: ['module', 'id', 'link_field', 'related_ids'],
      properties: {
        module: { type: 'string' },
        id: { type: 'string' },
        link_field: { type: 'string' },
        related_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: `${PREFIX}_get_module_fields`,
    description: 'Get module fields',
    inputSchema: {
      type: 'object',
      required: ['module'],
      properties: {
        module: { type: 'string' },
      },
    },
  },
  {
    name: `${PREFIX}_list_modules`,
    description: 'List modules',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: `${PREFIX}_server_info`,
    description: 'Server info',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function createMcpServer(sid) {
  const srv = new Server(
    { name: `suitecrm-${PREFIX}`, version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const reqId = randomUUID();
    const cLog = (connLoggers.get(sid) || logger).child({ reqId });
    const callStart = Date.now();
    const end = metricToolDuration.startTimer({ entity: PREFIX, tool: name });
    cLog.info({ audit: true, tool: name, args: redactAuditArgs(args) }, 'tool_call');
    try {
      let result;
      if (name === `${PREFIX}_search`) result = await searchRecords(sid, args);
      else if (name === `${PREFIX}_search_text`) result = await searchText(sid, args);
      else if (name === `${PREFIX}_get`) result = await getRecord(sid, args);
      else if (name === `${PREFIX}_create`) result = await createRecord(sid, args);
      else if (name === `${PREFIX}_update`) result = await updateRecord(sid, args);
      else if (name === `${PREFIX}_delete`) result = await deleteRecord(sid, args);
      else if (name === `${PREFIX}_count`) result = await countRecords(sid, args);
      else if (name === `${PREFIX}_get_relationships`) result = await getRelationships(sid, args);
      else if (name === `${PREFIX}_link_records`) result = await linkRecords(sid, args);
      else if (name === `${PREFIX}_unlink_records`) result = await unlinkRecords(sid, args);
      else if (name === `${PREFIX}_get_module_fields`) result = await getModuleFields(sid, args);
      else if (name === `${PREFIX}_list_modules`) result = await listModules(sid);
      else if (name === `${PREFIX}_server_info`) result = await serverInfo(sid);
      else throw new McpError(ErrorCode.MethodNotFound, `Unknown: ${name}`);

      end();
      metricToolCalls.inc({ entity: PREFIX, tool: name, status: 'success' });
      cLog.info({ audit: true, tool: name, status: 'success', durationMs: Date.now() - callStart }, 'tool_done');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      end();
      metricToolCalls.inc({ entity: PREFIX, tool: name, status: 'error' });
      cLog.error({ audit: true, tool: name, status: 'error', err: err.message }, 'tool_error');
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return srv;
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const sseRL = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many connection attempts - try again in 15 minutes' },
  keyGenerator: (req) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
      const sess = loadSessions()[token];
      if (sess?.sub) { req._rlSess = sess; return sess.sub; }
    }
    return req.ip;
  },
  handler: (req, res, next, options) => {
    const key = req.rateLimit?.key || req.ip;
    metricRateLimited.inc({ entity: PREFIX, route: 'sse' });
    logger.warn({ route: 'sse', sub: key, email: req._rlSess?.email }, 'rate_limit_hit');
    res.status(options.statusCode).json(options.message);
  },
});

const messagesRL = rateLimit({
  windowMs: 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many tool calls - slow down' },
  keyGenerator: (req) => subBySid.get(req.query.sessionId) || req.ip,
  handler: (req, res, next, options) => {
    const key = req.rateLimit?.key || req.ip;
    metricRateLimited.inc({ entity: PREFIX, route: 'messages' });
    logger.warn({ route: 'messages', sub: key }, 'rate_limit_hit');
    res.status(options.statusCode).json(options.message);
  },
});

const deepHealthRL = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many health check requests' },
  handler: (req, res, next, options) => {
    metricRateLimited.inc({ entity: PREFIX, route: 'health_deep' });
    res.status(options.statusCode).json(options.message);
  },
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use((req, res, next) =>
  req.path === '/messages' ? next() : express.json()(req, res, next)
);

app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    entity: CODE,
    port: PORT,
    active: transports.size,
    circuit_breaker: circuitBreaker.state.toLowerCase(),
  })
);

app.get('/health/deep', deepHealthRL, async (_req, res) => {
  const start = Date.now();
  const checks = {};
  let status = 'healthy';

  try {
    const parsed = new URL(ENDPOINT);
    checks.endpoint = { status: 'ok', url: `${parsed.protocol}//${parsed.host}` };
  } catch {
    checks.endpoint = { status: 'error', message: 'Invalid endpoint URL' };
    status = 'unhealthy';
  }

  if (status !== 'unhealthy') {
    try {
      const t = Date.now();
      await rawCall('get_server_info', {});
      checks.api = { status: 'ok', latency_ms: Date.now() - t };
    } catch (err) {
      checks.api = { status: 'error', message: err.message };
      status = 'degraded';
    }
  }

  checks.sessions = { status: 'ok', active: transports.size };

  res.status(status === 'unhealthy' ? 503 : 200).json({
    status,
    entity: CODE,
    port: PORT,
    uptime: Math.floor(process.uptime()),
    connections: transports.size,
    circuit_breaker: circuitBreaker.state.toLowerCase(),
    checks,
    duration_ms: Date.now() - start,
  });
});

app.get('/test', sseRL, jwtMiddleware, profileMiddleware, groupAccessMiddleware, async (req, res) => {
  try {
    await crmLogin(req.crmCreds.user, req.crmCreds.pass);
    res.json({ success: true, crm_user: req.crmCreds.user, entity: CODE });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/sse', sseRL, jwtMiddleware, profileMiddleware, groupAccessMiddleware, async (req, res) => {
  if (transports.size >= 100) {
    metricConnectionRejected.inc({ entity: PREFIX });
    return res.status(503).json({ error: 'Too many connections' });
  }

  const transport = new SSEServerTransport(`${CODE ? `/${CODE}` : ''}/messages`, res);
  const sid = transport.sessionId;
  const srv = createMcpServer(sid);

  connCreds.set(sid, req.crmCreds);
  transports.set(sid, transport);
  subBySid.set(sid, req.auth.sub);

  const connLogger = logger.child({ sub: req.auth.sub, email: req.auth.email, sessionId: sid });
  connLoggers.set(sid, connLogger);
  connLogger.info('sse_connected');

  metricActiveConnections.set({ entity: PREFIX }, transports.size);
  metricConnections.inc({ entity: PREFIX });

  ensureCrmSession(sid).catch(err => {
    connLogger.error({ err: err.message }, 'crm_login_failed');
  });

  res.on('close', () => {
    connLogger.info('sse_disconnected');
    transports.delete(sid);
    connCreds.delete(sid);
    subBySid.delete(sid);
    connLoggers.delete(sid);
    metricActiveConnections.set({ entity: PREFIX }, transports.size);
  });

  await srv.connect(transport);
});

app.post('/messages', messagesRL, async (req, res) => {
  const sid = req.query.sessionId;
  const t = transports.get(sid);
  if (!t) return res.status(404).json({ error: 'Session not found' });

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Bearer token required' });
  const session = loadSessions()[token];
  const expectedSub = subBySid.get(sid);
  if (!session || !expectedSub || session.sub !== expectedSub) {
    return res.status(403).json({ error: 'Token does not match session owner' });
  }
  if (session.expiresAt < Date.now()) {
    return res.status(401).json({ error: 'Session expired' });
  }

  await t.handlePostMessage(req, res);
});

function gracefulShutdown(signal) {
  logger.info({ connections: transports.size, signal }, 'shutdown');
  for (const [, t] of transports) t.close?.();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

const BIND_HOST = (process.env.BIND_HOST || '127.0.0.1').trim();
app.listen(PORT, BIND_HOST, () => {
  logger.info({ host: BIND_HOST, port: PORT }, 'server_listening');
});

// ---------------------------------------------------------------------------
// Metrics server (separate port, localhost only)
// ---------------------------------------------------------------------------
const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
    res.end(await metricsRegistry.metrics());
  } else {
    res.writeHead(404); res.end();
  }
});
metricsServer.listen(METRICS_PORT, METRICS_BIND, () => {
  logger.info({ host: METRICS_BIND, port: METRICS_PORT }, 'metrics_listening');
});
