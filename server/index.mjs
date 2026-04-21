#!/usr/bin/env node
/**
 * SuiteCRM MCP Gateway Server — v3.0
 * Transport:  HTTP + Server-Sent Events
 * Auth:       OAuth2 Authorization Code (Auth0 / Azure AD / Okta / any OIDC)
 *             + gateway-issued API keys stored server-side
 * SDK:        @modelcontextprotocol/sdk 1.29.0
 *
 * Required environment variables:
 *   SUITECRM_ENDPOINT          CRM v4_1 REST endpoint URL
 *   OAUTH_ISSUER               OIDC issuer, e.g. https://your-tenant.auth0.com/
 *   OAUTH_AUDIENCE             API audience, e.g. https://your-gateway.example.com
 *   OAUTH_CLIENT_ID            OAuth app client ID
 *   OAUTH_CLIENT_SECRET        OAuth app client secret
 *   OAUTH_REDIRECT_URI         e.g. https://your-gateway.example.com/auth/callback
 *   GATEWAY_EXTERNAL_URL       base URL shown in setup snippets (no trailing slash)
 *   API_KEY_SECRET             random secret >= 32 chars, used to bind keys to this instance
 *   REQUIRED_GROUP             IdP group required to access this entity
 *
 * Optional environment variables:
 *   SUITECRM_PREFIX            tool name prefix (default: suitecrm)
 *   SUITECRM_CODE              entity code for multi-entity nginx routing
 *   PORT                       listen port (default: 3101)
 *   BIND_HOST                  interface to bind (default: 127.0.0.1)
 *   METRICS_PORT               Prometheus metrics port (default: 9090)
 *   METRICS_BIND               metrics bind host (default: 127.0.0.1)
 *   CRM_TIMEOUT_MS             CRM request timeout ms (default: 30000)
 *   CIRCUIT_BREAKER_THRESHOLD  failures before open (default: 5)
 *   CIRCUIT_BREAKER_RESET_MS   recovery window ms (default: 60000)
 *   OAUTH_GROUPS_CLAIM         JWT claim for groups (default: {audience}/groups)
 *   API_KEY_TTL_DAYS           key lifetime in days (default: 90)
 *   PROFILES_FILE              user profiles path (default: /etc/suitecrm-mcp/user-profiles.json)
 *   CRM_HOSTS_FILE             SSH host config path (default: /etc/suitecrm-mcp/crm-hosts.json)
 *   ENTITIES_CONFIG            all-entities config (default: /etc/suitecrm-mcp/entities.json)
 *   NODE_TLS_REJECT_UNAUTHORIZED  set to "0" for self-signed CRM certs only
 *   TRUST_PROXY                set to "1" when behind nginx
 */

import { Server }             from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomBytes, createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { execFile }  from 'child_process';
import { promisify } from 'util';
import express    from 'express';
import bodyParser from 'body-parser';
import { rateLimit } from 'express-rate-limit';
import https from 'https';
import http  from 'http';
import jwksRsa from 'jwks-rsa';
import jwt    from 'jsonwebtoken';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('./package.json');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const ENDPOINT      = (process.env.SUITECRM_ENDPOINT  || '').trim();
const PREFIX        = (process.env.SUITECRM_PREFIX     || 'suitecrm').trim();
const CODE          = (process.env.SUITECRM_CODE       || '').trim();
const PORT          = parseInt(process.env.PORT         || '3101', 10);
const BIND_HOST     = (process.env.BIND_HOST           || '127.0.0.1').trim();
const METRICS_PORT  = parseInt(process.env.METRICS_PORT || '9090', 10);
const METRICS_BIND  = (process.env.METRICS_BIND        || '127.0.0.1').trim();
const TLS_OK        = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';

const CRM_REQUEST_TIMEOUT_MS   = parseInt(process.env.CRM_TIMEOUT_MS             || '30000', 10);
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5',     10);
const CIRCUIT_BREAKER_RESET_MS  = parseInt(process.env.CIRCUIT_BREAKER_RESET_MS  || '60000', 10);

// OAuth / Auth
const OAUTH_ISSUER        = (process.env.OAUTH_ISSUER         || '').trim().replace(/\/$/, '');
const OAUTH_AUDIENCE      = (process.env.OAUTH_AUDIENCE       || '').trim();
const OAUTH_CLIENT_ID     = (process.env.OAUTH_CLIENT_ID      || '').trim();
const OAUTH_CLIENT_SECRET = (process.env.OAUTH_CLIENT_SECRET  || '').trim();
const OAUTH_REDIRECT_URI  = (process.env.OAUTH_REDIRECT_URI   || '').trim();
const GATEWAY_EXTERNAL_URL = (process.env.GATEWAY_EXTERNAL_URL || '').trim().replace(/\/$/, '');
const GROUPS_CLAIM        = (process.env.OAUTH_GROUPS_CLAIM   || `${OAUTH_AUDIENCE}/groups`).trim();
const REQUIRED_GROUP      = (process.env.REQUIRED_GROUP       || '').trim();
const API_KEY_SECRET      = (process.env.API_KEY_SECRET       || '').trim();
const API_KEY_TTL_DAYS    = parseInt(process.env.API_KEY_TTL_DAYS || '90', 10);

// Storage
const PROFILES_FILE   = (process.env.PROFILES_FILE  || '/etc/suitecrm-mcp/user-profiles.json').trim();
const CRM_HOSTS_FILE  = (process.env.CRM_HOSTS_FILE || '/etc/suitecrm-mcp/crm-hosts.json').trim();
const ENTITIES_CONFIG = (process.env.ENTITIES_CONFIG || '/etc/suitecrm-mcp/entities.json').trim();

// Rate limits
const AUTH_RATE_LIMIT_WINDOW_MS  = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX        = 20;
const TOOL_RATE_LIMIT_WINDOW_MS  = 60 * 1000;
const TOOL_RATE_LIMIT_MAX        = 100;
const POLL_RATE_LIMIT_WINDOW_MS  = 60 * 1000;
const POLL_RATE_LIMIT_MAX        = 30;

// Misc
const MAX_SEARCH_RESULTS   = 100;
const TOOL_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const CRM_API_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const STATE_TTL_MS         = 10 * 60 * 1000; // 10 min
const PENDING_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min

// Startup checks
const OAUTH_CONFIGURED = !!(OAUTH_ISSUER && OAUTH_AUDIENCE && OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && OAUTH_REDIRECT_URI);

if (!ENDPOINT) {
  process.stderr.write('FATAL: SUITECRM_ENDPOINT is required\n');
  process.exit(1);
}
if (OAUTH_CONFIGURED && !API_KEY_SECRET) {
  process.stderr.write('FATAL: API_KEY_SECRET is required when OAuth is configured\n');
  process.exit(1);
}
if (OAUTH_CONFIGURED && API_KEY_SECRET.length < 32) {
  process.stderr.write('FATAL: API_KEY_SECRET must be at least 32 characters\n');
  process.exit(1);
}

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
  labelNames: ['entity', 'tool'], buckets: TOOL_LATENCY_BUCKETS, registers: [metricsRegistry],
});
const metricCrmApiDuration = new Histogram({
  name: 'suitecrm_mcp_crm_api_duration_seconds', help: 'CRM REST API call duration in seconds',
  labelNames: ['entity', 'method'], buckets: CRM_API_LATENCY_BUCKETS, registers: [metricsRegistry],
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

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const transports  = new Map(); // sessionId -> SSEServerTransport
const crmSessions = new Map(); // "sub:code"  -> CRM session token (survives reconnects)
const connCreds   = new Map(); // sessionId   -> { user, pass }
const subBySid    = new Map(); // sessionId   -> sub

// OAuth state store (CSRF protection)
const pendingStates = new Map(); // state -> created_at

// Bridge token pickup store (legacy linux_user polling)
const pendingTokens = new Map(); // sub -> { api_key, entities, linux_user, created_at }

// Nonce-based bridge auth sessions (lazy auth)
const pendingBridgeSessions = new Map(); // nonce -> { linux_user, created_at, resolved, api_key?, entities? }
const BRIDGE_SESSION_TTL_MS = 15 * 60 * 1000;

// API key index (fast O(1) lookup)
const apiKeyIndex = new Map(); // api_key -> sub

// Periodic cleanup of stale state and pending tokens
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates)  if (now - v.created_at > STATE_TTL_MS)         pendingStates.delete(k);
  for (const [k, v] of pendingTokens)  if (now - v.created_at > PENDING_TOKEN_TTL_MS) pendingTokens.delete(k);
  for (const [k, v] of pendingBridgeSessions) if (now - v.created_at > BRIDGE_SESSION_TTL_MS) pendingBridgeSessions.delete(k);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
const circuitBreaker = {
  state: 'CLOSED', failures: 0, lastFailure: 0,
  isOpen() {
    if (this.state === 'CLOSED') return false;
    if (Date.now() - this.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
      this.state = 'HALF_OPEN';
      metricCircuitBreakerState.set({ entity: PREFIX }, 1);
      process.stderr.write(`[${PREFIX}] Circuit breaker HALF_OPEN\n`);
      return false;
    }
    return true;
  },
  recordSuccess() {
    if (this.state !== 'CLOSED') process.stderr.write(`[${PREFIX}] Circuit breaker CLOSED\n`);
    this.state = 'CLOSED'; this.failures = 0;
    metricCircuitBreakerState.set({ entity: PREFIX }, 0);
  },
  recordFailure() {
    this.failures++; this.lastFailure = Date.now();
    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD && this.state !== 'OPEN') {
      this.state = 'OPEN';
      metricCircuitBreakerState.set({ entity: PREFIX }, 2);
      metricCircuitBreakerOpenings.inc({ entity: PREFIX });
      process.stderr.write(`[${PREFIX}] Circuit breaker OPEN after ${this.failures} failures\n`);
    }
  },
};

// ---------------------------------------------------------------------------
// CRM HTTP layer
// ---------------------------------------------------------------------------
function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const body   = new URLSearchParams(params).toString();
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     `SuiteCRM-MCP-Gateway/${PKG_VERSION}`,
      },
      rejectUnauthorized: TLS_OK,
    }, (res) => {
      let raw = ''; let rawLen = 0;
      const MAX_BYTES = 10 * 1024 * 1024;
      res.on('data', c => {
        rawLen += c.length;
        if (rawLen > MAX_BYTES) { req.destroy(new Error('CRM response exceeds 10 MB')); return; }
        raw += c;
      });
      res.on('end', () => {
        try   { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`Non-JSON (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`)); }
      });
    });
    req.setTimeout(CRM_REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function rawCall(method, restData) {
  const end = metricCrmApiDuration.startTimer({ entity: PREFIX, method });
  try {
    const r = await postForm(ENDPOINT, {
      method, input_type: 'JSON', response_type: 'JSON',
      rest_data: JSON.stringify(restData),
    });
    if (r && typeof r.number === 'number' && r.number !== 0) {
      const e = new Error(r.name || r.description || `CRM API error ${r.number}`);
      e.code = r.number; throw e;
    }
    end(); return r;
  } catch (err) { end(); throw err; }
}

async function crmLogin(user, pass) {
  const r = await rawCall('login', {
    user_auth: { user_name: user, password: createHash('md5').update(pass).digest('hex') },
    application_name: 'SuiteCRM-MCP-Gateway', name_value_list: [],
  });
  if (!r.id || r.id === 0 || r.id === '0')
    throw new Error(`CRM login failed for "${user}": ${r.description || r.name || 'Invalid Login'}`);
  return r.id;
}

async function ensureCrmSession(sid) {
  const sub    = subBySid.get(sid) || sid;
  const crmKey = `${sub}:${CODE || 'default'}`;
  if (crmSessions.has(crmKey)) return crmSessions.get(crmKey);
  const creds  = connCreds.get(sid);
  if (!creds) throw new Error(`No credentials for session ${sid.slice(0, 8)}`);
  const crmSid = await crmLogin(creds.user, creds.pass);
  crmSessions.set(crmKey, crmSid);
  process.stderr.write(`[${PREFIX}] CRM session opened for "${creds.user}" (sid=${sid.slice(0,8)})\n`);
  return crmSid;
}

async function crmCall(sid, method, params) {
  if (circuitBreaker.isOpen())
    throw new Error(`Circuit breaker open - CRM unavailable (${circuitBreaker.failures} consecutive failures)`);
  let crmSid;
  try { crmSid = await ensureCrmSession(sid); }
  catch (err) { if (!err.code) circuitBreaker.recordFailure(); throw err; }
  try {
    const result = await rawCall(method, { session: crmSid, ...params });
    circuitBreaker.recordSuccess(); return result;
  } catch (err) {
    if (err.code === 11) {
      process.stderr.write(`[${PREFIX}] Session expired - re-logging in\n`);
      metricSessionRenewals.inc({ entity: PREFIX });
      const sub = subBySid.get(sid) || sid;
      crmSessions.delete(`${sub}:${CODE || 'default'}`);
      try {
        crmSid = await ensureCrmSession(sid);
        const result = await rawCall(method, { session: crmSid, ...params });
        circuitBreaker.recordSuccess(); return result;
      } catch (retryErr) { if (!retryErr.code) circuitBreaker.recordFailure(); throw retryErr; }
    }
    if (!err.code) circuitBreaker.recordFailure(); throw err;
  }
}

// ---------------------------------------------------------------------------
// Input validation / sanitization
// ---------------------------------------------------------------------------
const BLOCKED_SQL      = /\b(DROP|ALTER|TRUNCATE|INSERT|UPDATE|DELETE|EXEC|EXECUTE|CREATE|GRANT|REVOKE|UNION\s+SELECT|INTO\s+OUTFILE|LOAD_FILE|BENCHMARK|SLEEP)\b/i;
const BLOCKED_PATTERNS = /;|--|\/\*|\*\//;
function sanitizeQuery(q) {
  if (!q) return q;
  if (BLOCKED_SQL.test(q))     throw new McpError(ErrorCode.InvalidParams, 'Query contains blocked SQL keyword');
  if (BLOCKED_PATTERNS.test(q)) throw new McpError(ErrorCode.InvalidParams, 'Query contains disallowed characters (;, --, or block comments)');
  return q;
}
const SAFE_MODULE    = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_LINK_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const SAFE_LINUX_USER = /^[a-z_][a-z0-9._-]{0,31}$/;
const SAFE_API_KEY    = /^smcp_[0-9a-f]{72}$/;

function validateModule(m)   { if (!m || !SAFE_MODULE.test(m))     throw new McpError(ErrorCode.InvalidParams, `Invalid module name: ${String(m).slice(0,40)}`); }
function validateId(id)      { if (!id || !UUID_RE.test(id))        throw new McpError(ErrorCode.InvalidParams, `Invalid record ID: ${String(id).slice(0,40)}`); }
function validateLinkField(f){ if (!f || !SAFE_LINK_FIELD.test(f)) throw new McpError(ErrorCode.InvalidParams, `Invalid link_field: ${String(f).slice(0,40)}`); }

// ---------------------------------------------------------------------------
// Tool implementations (unchanged from v2.x)
// ---------------------------------------------------------------------------
async function searchRecords(sid, { module, query='', fields=[], max_results=20, offset=0, order_by='' }) {
  validateModule(module); sanitizeQuery(query); if (order_by) sanitizeQuery(order_by);
  const r = await crmCall(sid, 'get_entry_list', {
    module_name: module, query, order_by, offset, select_fields: fields,
    link_name_to_fields_array: [], max_results: Math.min(max_results, MAX_SEARCH_RESULTS),
    deleted: 0, favorites: false,
  });
  return { module, records: flatList(r.entry_list), result_count: r.result_count||0,
           total_count: parseInt(r.total_count||'0',10), next_offset: r.next_offset||0 };
}

async function searchText(sid, { search_string, modules=['Accounts','Contacts','Leads'], max_results=10 }) {
  if (!search_string || typeof search_string !== 'string' || search_string.length > 500)
    throw new McpError(ErrorCode.InvalidParams, 'search_string must be a non-empty string of at most 500 characters');
  for (const m of modules) validateModule(m);
  const r = await crmCall(sid, 'search_by_module', {
    search_string, modules, offset: 0, max_results, assigned_user_id: '',
    select_fields: [], unified_search_only: false, favorites: false,
  });
  const out = {};
  for (const entry of (r.entry_list || [])) {
    out[entry.name] = (entry.records || []).map(rec => {
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
  validateModule(module); validateId(id);
  const r = await crmCall(sid, 'get_entry', {
    module_name: module, id, select_fields: fields,
    link_name_to_fields_array: [], track_view: false,
  });
  const recs = flatList(r.entry_list);
  return recs.length ? recs[0] : null;
}

async function createRecord(sid, { module, fields }) {
  validateModule(module);
  const r = await crmCall(sid, 'set_entry', { module_name: module, name_value_list: toNvl(fields) });
  return { id: r.id, module, created: true };
}

async function updateRecord(sid, { module, id, fields }) {
  validateModule(module); validateId(id);
  const r = await crmCall(sid, 'set_entry', {
    module_name: module, name_value_list: [{ name: 'id', value: id }, ...toNvl(fields)],
  });
  return { id: r.id, module, updated: true };
}

async function deleteRecord(sid, { module, id }) {
  validateModule(module); validateId(id);
  const r = await crmCall(sid, 'set_entry', {
    module_name: module,
    name_value_list: [{ name: 'id', value: id }, { name: 'deleted', value: '1' }],
  });
  return { id: r.id, module, deleted: true };
}

async function countRecords(sid, { module, query='' }) {
  validateModule(module); sanitizeQuery(query);
  const r = await crmCall(sid, 'get_entries_count', { module_name: module, query, deleted: 0 });
  return { module, count: parseInt(r.result_count||'0',10) };
}

async function getRelationships(sid, { module, id, link_field, related_fields=[], max_results=20, offset=0 }) {
  validateModule(module); validateId(id); validateLinkField(link_field);
  const r = await crmCall(sid, 'get_relationships', {
    module_name: module, module_id: id, link_field_name: link_field,
    related_module_query: '', related_fields,
    related_module_link_name_to_fields_array: [],
    deleted: 0, order_by: '', offset, limit: max_results,
  });
  return { records: flatList(r.entry_list), count: (r.entry_list||[]).length };
}

async function linkRecords(sid, { module, id, link_field, related_ids }) {
  validateModule(module); validateId(id); validateLinkField(link_field);
  const ids = Array.isArray(related_ids) ? related_ids : [related_ids];
  for (const rid of ids) validateId(rid);
  const r = await crmCall(sid, 'set_relationship', {
    module_name: module, module_id: id, link_field_name: link_field,
    related_ids: ids, name_value_list: [], delete: 0,
  });
  return { created: r.created, failed: r.failed };
}

async function unlinkRecords(sid, { module, id, link_field, related_ids }) {
  validateModule(module); validateId(id); validateLinkField(link_field);
  const ids = Array.isArray(related_ids) ? related_ids : [related_ids];
  for (const rid of ids) validateId(rid);
  const r = await crmCall(sid, 'set_relationship', {
    module_name: module, module_id: id, link_field_name: link_field,
    related_ids: ids, name_value_list: [], delete: 1,
  });
  return { deleted: r.deleted, failed: r.failed };
}

async function getModuleFields(sid, { module }) {
  validateModule(module);
  const r = await crmCall(sid, 'get_module_fields', { module_name: module, fields: [] });
  return {
    module: r.module_name, table: r.table_name,
    fields: Object.values(r.module_fields||{}).map(f => ({
      name: f.name, type: f.type, label: f.label, required: f.required,
      options: f.options ? Object.keys(f.options) : undefined,
    })),
    relationships: (r.link_fields||[]).map(l => ({ name: l.name, related_module: l.module })),
  };
}

async function listModules(sid) {
  const r = await crmCall(sid, 'get_available_modules', { filter: 'all' });
  return (r.modules||[]).map(m => ({ key: m.module_key, label: m.module_label }));
}

async function serverInfo(sid) {
  const creds = connCreds.get(sid) || {};
  const sub   = subBySid.get(sid);
  return {
    prefix: PREFIX, port: PORT, entity: CODE || 'default',
    endpoint: ENDPOINT.replace(/^(https?:\/\/[^/]+).*/, '$1'),
    crm_user: creds.user || '?',
    auth: 'OAuth2-API-Key',
    session_active: crmSessions.has(`${sub||sid}:${CODE||'default'}`),
    active_connections: transports.size,
    circuit_breaker: circuitBreaker.state.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function flatNvl(nvl) {
  if (!nvl || typeof nvl !== 'object') return {};
  const out = {};
  for (const k of Object.keys(nvl)) {
    const v = nvl[k];
    out[k] = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  }
  return out;
}
function flatList(el) { return (el||[]).map(e => flatNvl(e.name_value_list || e)); }
function toNvl(obj)   { return Object.entries(obj).map(([n,v]) => ({ name:n, value:String(v??'') })); }

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emailToLinuxUser(email) {
  return email.split('@')[0]
    .toLowerCase()
    .replace(/\+[^+]*/g, '')       // strip +tags
    .replace(/[^a-z0-9._-]/g, '')  // strip invalid Linux username chars
    .slice(0, 32)
    || 'unknown';
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const MODULE_LIST = ['Accounts','Contacts','Leads','Opportunities','Cases',
  'Calls','Meetings','Tasks','Notes','Emails','Documents','Campaigns',
  'AOS_Quotes','AOS_Invoices','AOS_Products','AOS_Contracts',
  'AOR_Reports','AOW_WorkFlow','SecurityGroups'].join(', ');

const TOOLS = [
  { name:`${PREFIX}_search`, description:`Search records using a SQL WHERE clause. Modules: ${MODULE_LIST}.`,
    inputSchema:{ type:'object', required:['module'], properties:{
      module:{type:'string'}, query:{type:'string'}, fields:{type:'array',items:{type:'string'}},
      max_results:{type:'number'}, offset:{type:'number'}, order_by:{type:'string'}}}},
  { name:`${PREFIX}_search_text`, description:'Full-text search across Accounts, Contacts, Leads (or specified modules).',
    inputSchema:{ type:'object', required:['search_string'], properties:{
      search_string:{type:'string'}, modules:{type:'array',items:{type:'string'}}, max_results:{type:'number'}}}},
  { name:`${PREFIX}_get`, description:'Get a single record by UUID.',
    inputSchema:{ type:'object', required:['module','id'], properties:{
      module:{type:'string'}, id:{type:'string'}, fields:{type:'array',items:{type:'string'}}}}},
  { name:`${PREFIX}_create`, description:'Create a new record.',
    inputSchema:{ type:'object', required:['module','fields'], properties:{
      module:{type:'string'}, fields:{type:'object',additionalProperties:{type:'string'}}}}},
  { name:`${PREFIX}_update`, description:'Update an existing record.',
    inputSchema:{ type:'object', required:['module','id','fields'], properties:{
      module:{type:'string'}, id:{type:'string'}, fields:{type:'object',additionalProperties:{type:'string'}}}}},
  { name:`${PREFIX}_delete`, description:'Soft-delete a record (sets deleted=1).',
    inputSchema:{ type:'object', required:['module','id'], properties:{module:{type:'string'},id:{type:'string'}}}},
  { name:`${PREFIX}_count`, description:'Count records matching a query.',
    inputSchema:{ type:'object', required:['module'], properties:{module:{type:'string'},query:{type:'string'}}}},
  { name:`${PREFIX}_get_relationships`, description:'Get related records via a link field.',
    inputSchema:{ type:'object', required:['module','id','link_field'], properties:{
      module:{type:'string'}, id:{type:'string'}, link_field:{type:'string'},
      related_fields:{type:'array',items:{type:'string'}}, max_results:{type:'number'}, offset:{type:'number'}}}},
  { name:`${PREFIX}_link_records`, description:'Create a relationship between two records.',
    inputSchema:{ type:'object', required:['module','id','link_field','related_ids'], properties:{
      module:{type:'string'}, id:{type:'string'}, link_field:{type:'string'}, related_ids:{type:'array',items:{type:'string'}}}}},
  { name:`${PREFIX}_unlink_records`, description:'Remove a relationship between records.',
    inputSchema:{ type:'object', required:['module','id','link_field','related_ids'], properties:{
      module:{type:'string'}, id:{type:'string'}, link_field:{type:'string'}, related_ids:{type:'array',items:{type:'string'}}}}},
  { name:`${PREFIX}_get_module_fields`, description:'Get field definitions and relationships for a module.',
    inputSchema:{ type:'object', required:['module'], properties:{module:{type:'string'}}}},
  { name:`${PREFIX}_list_modules`, description:'List all available CRM modules.',
    inputSchema:{ type:'object', properties:{}}},
  { name:`${PREFIX}_server_info`, description:'Show gateway status, auth info, and active connections.',
    inputSchema:{ type:'object', properties:{}}},
];

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------
function createMcpServer(sid) {
  const srv = new Server(
    { name: `suitecrm-gateway-${PREFIX}`, version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const end = metricToolDuration.startTimer({ entity: PREFIX, tool: name });
    try {
      let result;
      switch (name) {
        case `${PREFIX}_search`:            result = await searchRecords(sid,args);    break;
        case `${PREFIX}_search_text`:       result = await searchText(sid,args);       break;
        case `${PREFIX}_get`:               result = await getRecord(sid,args);        break;
        case `${PREFIX}_create`:            result = await createRecord(sid,args);     break;
        case `${PREFIX}_update`:            result = await updateRecord(sid,args);     break;
        case `${PREFIX}_delete`:            result = await deleteRecord(sid,args);     break;
        case `${PREFIX}_count`:             result = await countRecords(sid,args);     break;
        case `${PREFIX}_get_relationships`: result = await getRelationships(sid,args); break;
        case `${PREFIX}_link_records`:      result = await linkRecords(sid,args);      break;
        case `${PREFIX}_unlink_records`:    result = await unlinkRecords(sid,args);    break;
        case `${PREFIX}_get_module_fields`: result = await getModuleFields(sid,args);  break;
        case `${PREFIX}_list_modules`:      result = await listModules(sid);           break;
        case `${PREFIX}_server_info`:       result = await serverInfo(sid);            break;
        default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      end(); metricToolCalls.inc({ entity: PREFIX, tool: name, status: 'success' });
      return { content: [{ type:'text', text: JSON.stringify(result,null,2) }] };
    } catch (err) {
      end(); metricToolCalls.inc({ entity: PREFIX, tool: name, status: 'error' });
      const msg = [err.message, err.description].filter(Boolean).join(' - ');
      return { content: [{ type:'text', text:`Error: ${msg}` }], isError: true };
    }
  });
  return srv;
}

// ---------------------------------------------------------------------------
// OAuth / Auth utilities
// ---------------------------------------------------------------------------

// JWKS client - initialized lazily after OIDC discovery
let jwksClient = null;
let oidcEndpoints = null;

async function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': `SuiteCRM-MCP-Gateway/${PKG_VERSION}` },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`Non-JSON response from ${url}: ${raw.slice(0,200)}`)); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('OIDC discovery timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function ensureOidcEndpoints() {
  if (oidcEndpoints) return oidcEndpoints;
  const disco = await httpsGetJson(`${OAUTH_ISSUER}/.well-known/openid-configuration`);
  oidcEndpoints = {
    authorization_endpoint: disco.authorization_endpoint,
    token_endpoint:         disco.token_endpoint,
    jwks_uri:               disco.jwks_uri,
  };
  jwksClient = jwksRsa({
    jwksUri:               oidcEndpoints.jwks_uri,
    cache:                 true,
    cacheMaxAge:           10 * 60 * 1000,
    rateLimit:             true,
    jwksRequestsPerMinute: 10,
  });
  process.stderr.write(`[${PREFIX}] OIDC endpoints loaded from ${OAUTH_ISSUER}\n`);
  return oidcEndpoints;
}

async function exchangeCodeForTokens(code) {
  const endpoints = await ensureOidcEndpoints();
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    code,
    redirect_uri:  OAUTH_REDIRECT_URI,
  }).toString();
  const parsed = new URL(endpoints.token_endpoint);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     `SuiteCRM-MCP-Gateway/${PKG_VERSION}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.error) reject(new Error(`Token exchange failed: ${data.error} - ${data.error_description || ''}`));
          else resolve(data);
        } catch { reject(new Error(`Non-JSON token response: ${raw.slice(0,200)}`)); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Token exchange timed out')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function validateIdToken(idToken) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded?.header?.kid) throw new Error('ID token missing kid header');
  const key = await jwksClient.getSigningKey(decoded.header.kid);
  return jwt.verify(idToken, key.getPublicKey(), {
    audience: OAUTH_AUDIENCE,
    issuer:   `${OAUTH_ISSUER}/`,
  });
}

function generateApiKey() {
  const raw  = randomBytes(32).toString('hex');
  const hmac = createHmac('sha256', API_KEY_SECRET).update(raw).digest('hex').slice(0, 8);
  return `smcp_${raw}${hmac}`;
}

function isApiKeyExpired(issuedAt) {
  const ttlMs = API_KEY_TTL_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - new Date(issuedAt).getTime() > ttlMs;
}

// ---------------------------------------------------------------------------
// Profile store
// ---------------------------------------------------------------------------
function loadProfiles() {
  try   { return JSON.parse(readFileSync(PROFILES_FILE, 'utf8')); }
  catch { return {}; }
}

function saveProfiles(profiles) {
  const dir = PROFILES_FILE.split('/').slice(0,-1).join('/');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  const tmp = PROFILES_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(profiles, null, 2), { mode: 0o600 });
  renameSync(tmp, PROFILES_FILE);
}

// Async mutex -- serializes concurrent read-modify-write on profiles
let _profileLock = Promise.resolve();
function acquireProfileLock() {
  let release;
  const prev = _profileLock;
  _profileLock = new Promise(resolve => { release = resolve; });
  return prev.then(() => release);
}

function buildApiKeyIndex() {
  apiKeyIndex.clear();
  const profiles = loadProfiles();
  for (const [sub, profile] of Object.entries(profiles)) {
    if (profile.api_key) apiKeyIndex.set(profile.api_key, sub);
  }
}

function lookupApiKey(apiKey) {
  const sub = apiKeyIndex.get(apiKey);
  if (!sub) return null;
  const profiles = loadProfiles();
  const profile  = profiles[sub];
  if (!profile) return null;
  if (isApiKeyExpired(profile.api_key_issued_at)) return null;
  return { sub, profile };
}

// ---------------------------------------------------------------------------
// Entities config
// ---------------------------------------------------------------------------
function loadEntitiesConfig() {
  // Multi-entity: install.py writes /etc/suitecrm-mcp/entities.json
  if (existsSync(ENTITIES_CONFIG)) {
    try { return JSON.parse(readFileSync(ENTITIES_CONFIG, 'utf8')); } catch {}
  }
  // Single-entity fallback: derive from this process's own env vars
  const code = CODE || 'default';
  return {
    [code]: {
      label:          code,
      endpoint:       ENDPOINT,
      port:           PORT,
      group:          REQUIRED_GROUP,
      prefix:         PREFIX,
    },
  };
}

// ---------------------------------------------------------------------------
// SSH provisioning
// ---------------------------------------------------------------------------
async function sshProvisionUser(code, crmUser, crmPass, hostConfig) {
  const { ssh_host, ssh_user = 'ubuntu', ssh_key, command = '/usr/local/bin/crm-provision-user' } = hostConfig;
  if (!ssh_host) throw new Error(`No ssh_host configured for entity ${code}`);
  const keyPath = ssh_key || '/etc/suitecrm-mcp/crm-ssh-key';
  await execFileAsync('ssh', [
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    `${ssh_user}@${ssh_host}`,
    command, crmUser, crmPass,
  ]);
}

// ---------------------------------------------------------------------------
// Success page HTML
// ---------------------------------------------------------------------------
function renderSuccessPage({ email, linuxUser, accessibleEntities, apiKey, externalUrl }) {
  const base = externalUrl || GATEWAY_EXTERNAL_URL || '';

  const claudeCodeCmds = accessibleEntities.map(({ code, label }) => {
    const sseUrl = code === 'default' ? `${base}/sse` : `${base}/${code}/sse`;
    const name   = code === 'default' ? 'suitecrm' : `suitecrm_${code}`;
    return `# ${label}\nclaude mcp add ${name} \\\n  --transport sse \\\n  --header "Authorization: Bearer ${apiKey}" \\\n  ${sseUrl}`;
  }).join('\n\n');

  const claudeDesktopJson = {
    mcpServers: Object.fromEntries(
      accessibleEntities.map(({ code, label }) => {
        const sseUrl = code === 'default' ? `${base}/sse` : `${base}/${code}/sse`;
        const name   = code === 'default' ? 'suitecrm' : `suitecrm_${code}`;
        return [name, { type: 'sse', url: sseUrl, headers: { Authorization: `Bearer ${apiKey}` } }];
      })
    ),
  };

  const entityList = accessibleEntities.map(e => `<li><strong>${escapeHtml(e.code)}</strong> — ${escapeHtml(e.label)}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuiteCRM MCP Gateway — Authenticated</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
    .card{background:#1a1f2e;border:1px solid #2d3748;border-radius:12px;padding:2.5rem;max-width:720px;width:100%}
    h1{font-size:1.5rem;color:#68d391;margin-bottom:.5rem}
    .subtitle{color:#718096;font-size:.95rem;margin-bottom:1.5rem}
    .info-block{background:#0f1117;border:1px solid #2d3748;border-radius:8px;padding:1rem;margin-bottom:1.5rem}
    .info-block ul{list-style:none;padding-left:.5rem}
    .info-block li{padding:.2rem 0;color:#a0aec0}
    .info-block li strong{color:#e2e8f0}
    .notice{background:#1a2744;border:1px solid #3182ce;border-radius:8px;padding:1rem;margin-bottom:1.5rem;color:#90cdf4;font-size:.9rem}
    details{margin-bottom:1rem;border:1px solid #2d3748;border-radius:8px;overflow:hidden}
    summary{padding:1rem 1.25rem;cursor:pointer;font-weight:600;font-size:.95rem;background:#16213e;user-select:none;display:flex;align-items:center;gap:.5rem}
    summary:hover{background:#1e2d4e}
    summary::marker{content:''}
    summary .arrow{transition:transform .2s;display:inline-block}
    details[open] summary .arrow{transform:rotate(90deg)}
    .panel{padding:1.25rem;background:#0f1117}
    pre{background:#0a0d14;border:1px solid #2d3748;border-radius:6px;padding:1rem;font-size:.82rem;line-height:1.6;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#e2e8f0;margin-bottom:.75rem}
    .copy-btn{background:#2b6cb0;color:#fff;border:none;border-radius:6px;padding:.4rem .9rem;font-size:.83rem;cursor:pointer;font-family:inherit}
    .copy-btn:hover{background:#3182ce}
    .copy-btn.copied{background:#276749}
    .tag{display:inline-block;background:#2d3748;color:#a0aec0;font-size:.75rem;padding:.15rem .5rem;border-radius:4px;margin-right:.4rem}
    .openclaw-note{color:#68d391;font-size:.9rem}
  </style>
</head>
<body>
<div class="card">
  <h1>&#x2713; You're authenticated</h1>
  <p class="subtitle">Signed in as <strong>${escapeHtml(email)}</strong></p>

  <div class="info-block">
    <p style="margin-bottom:.5rem;font-size:.85rem;color:#718096;text-transform:uppercase;letter-spacing:.05em">Entity access granted</p>
    <ul>${entityList}</ul>
  </div>

  <div class="notice">
    <span class="openclaw-note">&#x2713; OpenClaw users: you're done. Close this tab — your bridge will connect automatically within a few seconds.</span>
  </div>

  <details>
    <summary><span class="arrow">&#9654;</span> <span class="tag">Claude Code</span> Setup commands</summary>
    <div class="panel">
      <p style="color:#718096;font-size:.85rem;margin-bottom:.75rem">Paste these in your terminal:</p>
      <pre id="cc">${claudeCodeCmds}</pre>
      <button class="copy-btn" onclick="copyEl('cc',this)">Copy</button>
    </div>
  </details>

  <details>
    <summary><span class="arrow">&#9654;</span> <span class="tag">Claude Desktop</span> JSON config</summary>
    <div class="panel">
      <p style="color:#718096;font-size:.85rem;margin-bottom:.75rem">Add to <code>claude_desktop_config.json</code> then fully restart Claude Desktop:</p>
      <pre id="cd">${JSON.stringify(claudeDesktopJson, null, 2)}</pre>
      <button class="copy-btn" onclick="copyEl('cd',this)">Copy</button>
    </div>
  </details>
</div>
<script>
function copyEl(id,btn){
  navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>{
    btn.textContent='Copied!';btn.className='copy-btn copied';
    setTimeout(()=>{btn.textContent='Copy';btn.className='copy-btn'},2000);
  });
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Body parser — skip for /messages (MCP SDK needs raw body)
app.use((req, res, next) => {
  if (req.path === '/messages') return next();
  bodyParser.json()(req, res, next);
});

// Middleware: validate API key from Authorization: Bearer header
// Attaches req.apiUser = { sub, profile }
function requireApiKey(req, res, next) {
  const header = (req.headers.authorization || '').trim();
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization: Bearer <api-key> header required' });
  }
  const apiKey = header.slice(7).trim();
  if (!SAFE_API_KEY.test(apiKey)) {
    return res.status(401).json({ error: 'Invalid API key format' });
  }
  const found = lookupApiKey(apiKey);
  if (!found) {
    metricAuthFailures.inc({ entity: PREFIX });
    return res.status(401).json({ error: 'Invalid or expired API key. Visit the gateway to re-authenticate.' });
  }
  // Check entity access
  if (REQUIRED_GROUP) {
    const userGroups = found.profile.groups || [];
    const hasGroup   = userGroups.some(g => g === REQUIRED_GROUP || g.toLowerCase() === REQUIRED_GROUP.toLowerCase());
    if (!hasGroup) {
      return res.status(403).json({
        error:          `Access denied — not in required group "${REQUIRED_GROUP}"`,
        entity:         CODE || 'default',
        required_group: REQUIRED_GROUP,
        your_groups:    userGroups,
      });
    }
  }
  // Check CRM credentials exist for this entity
  const crmCreds = found.profile.entities?.[CODE || 'default'];
  if (!crmCreds?.user || !crmCreds?.pass) {
    return res.status(403).json({
      error:  `No CRM credentials found for entity "${CODE || 'default'}". Contact your administrator.`,
      entity: CODE || 'default',
    });
  }
  req.apiUser   = found;
  req.crmCreds  = crmCreds;
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Root → login page
app.get('/', (_req, res) => res.redirect('/auth/login'));

// Health (shallow, no auth)
app.get('/health', (_req, res) => res.json({
  status: 'ok', version: PKG_VERSION, prefix: PREFIX,
  entity: CODE || 'default', uptime: Math.floor(process.uptime()),
  connections: transports.size, circuit_breaker: circuitBreaker.state.toLowerCase(),
  auth: 'OAuth2-API-Key',
}));

const deepHealthRL = rateLimit({ windowMs: 60*1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many health check requests' } });

app.get('/health/deep', deepHealthRL, async (_req, res) => {
  const start = Date.now(); const checks = {}; let status = 'healthy';
  try {
    const parsed = new URL(ENDPOINT);
    checks.endpoint = { status: 'ok', url: `${parsed.protocol}//${parsed.host}` };
  } catch {
    checks.endpoint = { status: 'error', message: 'Invalid endpoint URL' }; status = 'unhealthy';
  }
  if (status !== 'unhealthy') {
    try {
      const t = Date.now(); await rawCall('get_server_info', {});
      checks.api = { status: 'ok', latency_ms: Date.now()-t };
    } catch (err) {
      checks.api = { status: 'error', message: err.message }; status = 'degraded';
    }
  }
  checks.sessions = { status: 'ok', active: transports.size };
  res.status(status === 'unhealthy' ? 503 : 200).json({
    status, version: PKG_VERSION, prefix: PREFIX, uptime: Math.floor(process.uptime()),
    connections: transports.size, circuit_breaker: circuitBreaker.state.toLowerCase(),
    checks, duration_ms: Date.now()-start,
  });
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
const authRL = rateLimit({ windowMs: AUTH_RATE_LIMIT_WINDOW_MS, max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many authentication attempts - try again in 15 minutes' } });

const pollRL = rateLimit({ windowMs: POLL_RATE_LIMIT_WINDOW_MS, max: POLL_RATE_LIMIT_MAX,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many poll requests' } });

// GET /auth/login — start OAuth2 Authorization Code flow
app.get('/auth/login', authRL, async (req, res) => {
  if (!OAUTH_CONFIGURED) {
    return res.status(501).json({ error: 'OAuth not configured. Set OAUTH_* environment variables.' });
  }
  try {
    const endpoints = await ensureOidcEndpoints();
    const state       = randomBytes(32).toString('hex');
    const bridgeNonce = (req.query.bridge || '').trim() || null;
    if (bridgeNonce && !pendingBridgeSessions.has(bridgeNonce)) {
      return res.status(400).json({ error: 'Invalid or expired bridge session. Request a new login link.' });
    }
    pendingStates.set(state, { created_at: Date.now(), nonce: bridgeNonce });

    const params = new URLSearchParams({
      client_id:     OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri:  OAUTH_REDIRECT_URI,
      scope:         'openid profile email offline_access',
      audience:      OAUTH_AUDIENCE,
      state,
    });
    res.redirect(`${endpoints.authorization_endpoint}?${params}`);
  } catch (err) {
    process.stderr.write(`[${PREFIX}] Auth login error: ${err.message}\n`);
    res.status(500).json({ error: 'Failed to start authentication. Check OIDC configuration.' });
  }
});

// GET /auth/callback — complete OAuth2 flow, provision user, issue API key
app.get('/auth/callback', authRL, async (req, res) => {
  if (!OAUTH_CONFIGURED) return res.status(501).json({ error: 'OAuth not configured' });

  const { code, state, error: oauthError, error_description } = req.query;

  if (oauthError) {
    return res.status(400).send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f1117;color:#e2e8f0">
      <h2 style="color:#fc8181">Authentication failed</h2>
      <p>${escapeHtml(oauthError)}: ${escapeHtml(error_description || '')}</p>
      <p><a href="/auth/login" style="color:#63b3ed">Try again</a></p>
    </body></html>`);
  }

  // CSRF check
  const stateData = pendingStates.get(state);
  if (!state || !stateData) {
    return res.status(400).json({ error: 'Invalid or expired state parameter. Please start authentication again.' });
  }
  pendingStates.delete(state);
  const bridgeNonce = stateData.nonce || null;

  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  try {
    // Exchange code for tokens
    const tokens   = await exchangeCodeForTokens(code);
    const claims   = await validateIdToken(tokens.id_token);

    const sub      = claims.sub;
    const email    = claims.email || '';
    const groups   = claims[GROUPS_CLAIM] || [];
    const linuxUser = emailToLinuxUser(email || sub);

    if (!email) {
      return res.status(400).json({ error: 'No email in token. Ensure the email scope is granted and email is verified.' });
    }

    // Load all entities to determine which ones this user can access
    const allEntities  = loadEntitiesConfig();
    const accessibleEntities = [];

    // Load SSH host config (optional)
    let crmHosts = {};
    if (existsSync(CRM_HOSTS_FILE)) {
      try { crmHosts = JSON.parse(readFileSync(CRM_HOSTS_FILE, 'utf8')); } catch {}
    }

    // Serialize concurrent OAuth callbacks to prevent profile clobber
    const releaseProfile = await acquireProfileLock();
    let apiKey;
    try {

    // Load existing profiles
    const profiles = loadProfiles();
    if (!profiles[sub]) {
      profiles[sub] = { sub, email, linux_user: linuxUser, groups, entities: {} };
    }
    profiles[sub].email      = email;
    profiles[sub].linux_user = linuxUser;
    profiles[sub].groups     = groups;
    if (tokens.refresh_token) profiles[sub].refresh_token = tokens.refresh_token;

    const provisionResults = [];

    for (const [entityCode, entityConfig] of Object.entries(allEntities)) {
      const entityGroup = entityConfig.group || '';

      // Check group membership
      const hasGroup = !entityGroup ||
        groups.some(g => g === entityGroup || g.toLowerCase() === entityGroup.toLowerCase());
      if (!hasGroup) continue;

      // Generate CRM credentials (random password, username from email prefix)
      const crmUser = linuxUser;
      const crmPass = randomBytes(16).toString('hex');

      // SSH provision if host is configured
      const hostConfig = crmHosts[entityCode];
      if (hostConfig?.ssh_host) {
        try {
          await sshProvisionUser(entityCode, crmUser, crmPass, hostConfig);
          profiles[sub].entities[entityCode] = { user: crmUser, pass: crmPass };
          provisionResults.push({ code: entityCode, status: 'provisioned' });
          process.stderr.write(`[${PREFIX}] Provisioned CRM user "${crmUser}" for entity ${entityCode}\n`);
        } catch (err) {
          const reason = err.stderr || err.message || '';
          // If user doesn't exist in CRM DB yet, report it clearly
          if (reason.includes('not found') || reason.includes('NO_USER')) {
            provisionResults.push({ code: entityCode, status: 'failed', reason: `CRM user "${crmUser}" not found in database — create the LDAP/AD user in SuiteCRM first` });
          } else {
            provisionResults.push({ code: entityCode, status: 'failed', reason: reason.slice(0, 200) });
          }
          process.stderr.write(`[${PREFIX}] SSH provision failed for ${entityCode}: ${reason.slice(0,200)}\n`);
          // Keep existing credentials if any; don't overwrite on failure
          if (!profiles[sub].entities[entityCode]?.user) continue;
        }
      } else {
        // No SSH config — keep existing credentials or mark as pending manual setup
        if (!profiles[sub].entities[entityCode]?.user) {
          profiles[sub].entities[entityCode] = { user: crmUser, pass: '', pending_manual_setup: true };
          provisionResults.push({ code: entityCode, status: 'pending', reason: 'No SSH config — admin must run mcp-profile-admin to set CRM credentials' });
        } else {
          provisionResults.push({ code: entityCode, status: 'existing' });
        }
      }

      accessibleEntities.push({ code: entityCode, label: entityConfig.label || entityCode });
    }

    if (accessibleEntities.length === 0) {
      return res.status(403).send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f1117;color:#e2e8f0">
        <h2 style="color:#fc8181">No entity access</h2>
        <p>Your account (${escapeHtml(email)}) is not in any required group. Contact your administrator.</p>
        <p>Groups in your token: ${escapeHtml(groups.join(', ') || '(none)')}</p>
      </body></html>`);
    }

    // Generate API key
    apiKey = generateApiKey();
    profiles[sub].api_key           = apiKey;
    profiles[sub].api_key_issued_at  = new Date().toISOString();

    // Save profiles and rebuild index
    saveProfiles(profiles);
    buildApiKeyIndex();

    } finally { releaseProfile(); }

    // Store in pending tokens for legacy linux_user bridge polling
    pendingTokens.set(sub, { api_key: apiKey, entities: accessibleEntities, linux_user: linuxUser, created_at: Date.now() });

    // Resolve nonce-based bridge session if this login came from a bridge/start request
    if (bridgeNonce && pendingBridgeSessions.has(bridgeNonce)) {
      const session = pendingBridgeSessions.get(bridgeNonce);
      session.api_key  = apiKey;
      session.entities = accessibleEntities;
      session.resolved = true;
    }

    process.stderr.write(`[${PREFIX}] Auth complete: "${email}" (${linuxUser}) entities=[${accessibleEntities.map(e=>e.code).join(',')}]\n`);

    // Render success page
    res.send(renderSuccessPage({ email, linuxUser, accessibleEntities, apiKey, externalUrl: GATEWAY_EXTERNAL_URL }));

  } catch (err) {
    process.stderr.write(`[${PREFIX}] Auth callback error: ${err.message}\n`);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f1117;color:#e2e8f0">
      <h2 style="color:#fc8181">Authentication error</h2>
      <p>${escapeHtml(err.message)}</p>
      <p><a href="/auth/login" style="color:#63b3ed">Try again</a></p>
    </body></html>`);
  }
});

// POST /auth/bridge/start — bridge requests a nonce-based auth session (lazy auth)
app.post('/auth/bridge/start', authRL, (req, res) => {
  if (!OAUTH_CONFIGURED) return res.status(501).json({ error: 'OAuth not configured' });

  const { linux_user } = req.body || {};
  if (!linux_user || !SAFE_LINUX_USER.test(linux_user)) {
    return res.status(400).json({ error: 'Invalid or missing linux_user' });
  }

  const nonce         = randomBytes(32).toString('hex');
  const client_secret = randomBytes(32).toString('hex');
  const loginUrl      = `${GATEWAY_EXTERNAL_URL}/auth/login?bridge=${nonce}`;
  pendingBridgeSessions.set(nonce, { linux_user, client_secret, created_at: Date.now(), resolved: false });

  process.stderr.write(`[${PREFIX}] Bridge auth session started for "${linux_user}" (nonce: ${nonce.slice(0, 8)}...)\n`);
  res.json({ nonce, client_secret, login_url: loginUrl, expires_in: 900 });
});

// GET /auth/bridge/poll/:nonce — bridge polls for auth completion (one-time pickup)
app.get('/auth/bridge/poll/:nonce', pollRL, (req, res) => {
  if (!OAUTH_CONFIGURED) return res.status(501).json({ error: 'OAuth not configured' });

  const { nonce } = req.params;
  if (!nonce || !/^[0-9a-f]{64}$/.test(nonce)) {
    return res.status(400).json({ error: 'Invalid nonce format' });
  }

  const session = pendingBridgeSessions.get(nonce);
  if (!session) {
    return res.status(404).json({ status: 'expired', message: 'Bridge session not found or expired' });
  }

  const secret = (req.headers['x-bridge-secret'] || '').trim();
  if (!secret || secret !== session.client_secret) {
    return res.status(401).json({ error: 'Invalid or missing X-Bridge-Secret header' });
  }

  if (!session.resolved) {
    return res.json({ status: 'pending' });
  }

  pendingBridgeSessions.delete(nonce);
  res.json({ status: 'ready', api_key: session.api_key, entities: session.entities });
});

// POST /auth/revoke — admin revokes a user's API key by linux_user or sub
app.post('/auth/revoke', (req, res) => {
  // Simple shared-secret admin auth
  const adminKey = (req.headers['x-admin-key'] || '').trim();
  const expected = createHmac('sha256', API_KEY_SECRET).update('admin-revoke').digest('hex');
  if (!adminKey || adminKey !== expected) {
    return res.status(401).json({ error: 'X-Admin-Key header required' });
  }

  const { linux_user, sub, api_key } = req.body || {};
  const profiles = loadProfiles();
  let revoked = false;

  for (const [s, profile] of Object.entries(profiles)) {
    if ((linux_user && profile.linux_user === linux_user) ||
        (sub        && s === sub) ||
        (api_key    && profile.api_key === api_key)) {
      apiKeyIndex.delete(profile.api_key);
      delete profiles[s].api_key;
      delete profiles[s].api_key_issued_at;
      revoked = true;
      process.stderr.write(`[${PREFIX}] API key revoked for "${profile.email || s}"\n`);
      break;
    }
  }

  if (!revoked) return res.status(404).json({ error: 'User not found' });
  saveProfiles(profiles);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// MCP routes
// ---------------------------------------------------------------------------
const sseRL = rateLimit({ windowMs: AUTH_RATE_LIMIT_WINDOW_MS, max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many connection attempts - try again in 15 minutes' } });

const messagesRL = rateLimit({ windowMs: TOOL_RATE_LIMIT_WINDOW_MS, max: TOOL_RATE_LIMIT_MAX,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many tool calls - slow down' } });

// GET /test — validate API key + CRM login
app.get('/test', sseRL, requireApiKey, async (req, res) => {
  try {
    await crmLogin(req.crmCreds.user, req.crmCreds.pass);
    res.json({
      success:  true,
      crm_user: req.crmCreds.user,
      email:    req.apiUser.profile.email,
      entity:   CODE || 'default',
    });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

// GET /sse — open MCP SSE session
app.get('/sse', sseRL, requireApiKey, async (req, res) => {
  const msgPath   = CODE ? `/${CODE}/messages` : '/messages';
  const transport = new SSEServerTransport(msgPath, res);
  const sid       = transport.sessionId;
  const sub       = req.apiUser.sub;
  const email     = req.apiUser.profile.email || sub;

  connCreds.set(sid, req.crmCreds);
  subBySid.set(sid, sub);

  // Eager CRM login
  try {
    await ensureCrmSession(sid);
  } catch (err) {
    connCreds.delete(sid); subBySid.delete(sid);
    metricAuthFailures.inc({ entity: PREFIX });
    process.stderr.write(`[${PREFIX}] CRM login failed for "${req.crmCreds.user}": ${err.message}\n`);
    return res.status(401).json({ error: `CRM authentication failed: ${err.message}` });
  }

  const srv = createMcpServer(sid);
  transports.set(sid, transport);
  metricActiveConnections.set({ entity: PREFIX }, transports.size);
  metricConnections.inc({ entity: PREFIX });

  res.on('close', () => {
    transports.delete(sid); connCreds.delete(sid); subBySid.delete(sid);
    // Keep crmSessions keyed by sub — reused on reconnect
    metricActiveConnections.set({ entity: PREFIX }, transports.size);
    process.stderr.write(`[${PREFIX}] Disconnected: "${email}" (sid=${sid.slice(0,8)})\n`);
  });

  await srv.connect(transport);
  process.stderr.write(`[${PREFIX}] Connected: "${email}" entity=${CODE||'default'} (sid=${sid.slice(0,8)})\n`);
});

// POST /messages — route to correct SSE session
app.post('/messages', messagesRL, async (req, res) => {
  const sid = req.query.sessionId;
  const t   = transports.get(sid);
  if (!t) return res.status(404).json({ error: `Session not found: ${sid}` });
  await t.handlePostMessage(req, res);
});

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------
process.on('SIGTERM', () => {
  process.stderr.write(`[${PREFIX}] SIGTERM received - shutting down\n`);
  for (const [, t] of transports) t.close?.();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Load API key index from existing profiles on startup
buildApiKeyIndex();
const indexSize = apiKeyIndex.size;
if (indexSize > 0) process.stderr.write(`[${PREFIX}] Loaded ${indexSize} API key(s) from profiles\n`);

// Warm up OIDC discovery in background (non-blocking)
if (OAUTH_CONFIGURED) {
  ensureOidcEndpoints().catch(err =>
    process.stderr.write(`[${PREFIX}] WARNING: OIDC discovery failed at startup: ${err.message}\n`)
  );
}

app.listen(PORT, BIND_HOST, (err) => {
  if (err) { process.stderr.write(`[${PREFIX}] FATAL: ${err.message}\n`); process.exit(1); }
  process.stderr.write(`[${PREFIX}] Gateway listening on ${BIND_HOST}:${PORT}\n`);
  process.stderr.write(`[${PREFIX}] CRM endpoint:  ${ENDPOINT}\n`);
  process.stderr.write(`[${PREFIX}] Entity:        ${CODE || 'default'}\n`);
  process.stderr.write(`[${PREFIX}] Auth:          ${OAUTH_CONFIGURED ? `OAuth2 (${OAUTH_ISSUER})` : 'NOT CONFIGURED'}\n`);
  if (!TLS_OK)   process.stderr.write(`[${PREFIX}] WARNING: TLS verification disabled\n`);
  if (!ENDPOINT.startsWith('https://'))
    process.stderr.write(`[${PREFIX}] WARNING: CRM endpoint is not HTTPS\n`);
  if (!OAUTH_CONFIGURED)
    process.stderr.write(`[${PREFIX}] WARNING: OAuth not configured — /sse will reject all connections\n`);
  if (GATEWAY_EXTERNAL_URL)
    process.stderr.write(`[${PREFIX}] Login URL:     ${GATEWAY_EXTERNAL_URL}/auth/login\n`);
});

// ---------------------------------------------------------------------------
// Metrics server (separate port, localhost only)
// ---------------------------------------------------------------------------
const METRICS_BIND_HOST = METRICS_BIND;
const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
    res.end(await metricsRegistry.metrics());
  } else {
    res.writeHead(404); res.end();
  }
});
metricsServer.listen(METRICS_PORT, METRICS_BIND_HOST, () => {
  process.stderr.write(`[${PREFIX}] Metrics on ${METRICS_BIND_HOST}:${METRICS_PORT}/metrics\n`);
});
