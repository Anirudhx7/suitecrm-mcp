#!/usr/bin/env node
/**
 * SuiteCRM MCP Gateway Server
 * Transport: HTTP + SSE | Auth: X-CRM-User/Pass headers | SDK: 1.29.0
 *
 * Environment variables:
 *   SUITECRM_ENDPOINT          - required, e.g. https://crm.example.com/service/v4_1/rest.php
 *   SUITECRM_PREFIX            - tool name prefix, default "suitecrm"
 *   PORT                       - listen port, default 3101
 *   METRICS_PORT               - Prometheus metrics port, default 9090 (localhost only)
 *   SUITECRM_CODE              - entity code for multi-entity nginx routing (leave blank for single)
 *   CRM_TIMEOUT_MS             - CRM API request timeout in ms, default 30000
 *   CIRCUIT_BREAKER_THRESHOLD  - consecutive failures before circuit opens, default 5
 *   CIRCUIT_BREAKER_RESET_MS   - ms before circuit tests recovery, default 60000
 *   BIND_HOST                  - interface to bind the gateway on, default "0.0.0.0" (use "127.0.0.1" for systemd installs behind nginx)
 *   NODE_TLS_REJECT_UNAUTHORIZED - set to "0" only for self-signed certs (with caution)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'crypto';
import express from 'express';
import bodyParser from 'body-parser';
import { rateLimit } from 'express-rate-limit';
import https from 'https';
import http from 'http';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('./package.json');

// ---------------------------------------------------------------------------
// Configuration constants  (must come before metrics so PREFIX is defined)
// ---------------------------------------------------------------------------
const ENDPOINT  = (process.env.SUITECRM_ENDPOINT || '').trim();
const PREFIX    = (process.env.SUITECRM_PREFIX || 'suitecrm').trim();
const PORT      = parseInt(process.env.PORT || '3101', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9090', 10);
const TLS_OK    = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';

const BIND_HOST = (process.env.BIND_HOST || '0.0.0.0').trim();
const CRM_REQUEST_TIMEOUT_MS    = parseInt(process.env.CRM_TIMEOUT_MS || '30000', 10);
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX       = 20;
const TOOL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TOOL_RATE_LIMIT_MAX       = 100;
const MAX_SEARCH_RESULTS        = 100;
const TOOL_LATENCY_BUCKETS      = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const CRM_API_LATENCY_BUCKETS   = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10);
const CIRCUIT_BREAKER_RESET_MS  = parseInt(process.env.CIRCUIT_BREAKER_RESET_MS || '60000', 10);

if (!ENDPOINT) {
  process.stderr.write('FATAL: SUITECRM_ENDPOINT is required\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ entity: PREFIX });
collectDefaultMetrics({ register: metricsRegistry });

const metricActiveConnections = new Gauge({
  name: 'suitecrm_mcp_active_connections',
  help: 'Number of active SSE connections',
  labelNames: ['entity'],
  registers: [metricsRegistry],
});

const metricConnections = new Counter({
  name: 'suitecrm_mcp_connections_total',
  help: 'Total SSE connections established',
  labelNames: ['entity'],
  registers: [metricsRegistry],
});

const metricToolCalls = new Counter({
  name: 'suitecrm_mcp_tool_calls_total',
  help: 'Total number of tool calls',
  labelNames: ['entity', 'tool', 'status'],
  registers: [metricsRegistry],
});

const metricToolDuration = new Histogram({
  name: 'suitecrm_mcp_tool_duration_seconds',
  help: 'Tool call duration in seconds',
  labelNames: ['entity', 'tool'],
  buckets: TOOL_LATENCY_BUCKETS,
  registers: [metricsRegistry],
});

const metricCrmApiDuration = new Histogram({
  name: 'suitecrm_mcp_crm_api_duration_seconds',
  help: 'CRM REST API call duration in seconds',
  labelNames: ['entity', 'method'],
  buckets: CRM_API_LATENCY_BUCKETS,
  registers: [metricsRegistry],
});

const metricSessionRenewals = new Counter({
  name: 'suitecrm_mcp_session_renewals_total',
  help: 'Total number of CRM session renewals',
  labelNames: ['entity'],
  registers: [metricsRegistry],
});

const metricAuthFailures = new Counter({
  name: 'suitecrm_mcp_auth_failures_total',
  help: 'Total number of CRM authentication failures',
  labelNames: ['entity'],
  registers: [metricsRegistry],
});

const metricCircuitBreakerState = new Gauge({
  name: 'suitecrm_mcp_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['entity'],
  registers: [metricsRegistry],
});

const metricCircuitBreakerOpenings = new Counter({
  name: 'suitecrm_mcp_circuit_breaker_openings_total',
  help: 'Total number of times circuit breaker opened',
  labelNames: ['entity'],
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const transports  = new Map();
const crmSessions = new Map();
const connCreds   = new Map();

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
const circuitBreaker = {
  state: 'CLOSED',
  failures: 0,
  lastFailure: 0,

  isOpen() {
    if (this.state === 'CLOSED') return false;
    if (Date.now() - this.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
      this.state = 'HALF_OPEN';
      metricCircuitBreakerState.set({ entity: PREFIX }, 1);
      process.stderr.write(`[${PREFIX}] Circuit breaker HALF_OPEN - testing recovery\n`);
      return false;
    }
    return true;
  },

  recordSuccess() {
    if (this.state !== 'CLOSED')
      process.stderr.write(`[${PREFIX}] Circuit breaker CLOSED - recovery successful\n`);
    this.state = 'CLOSED';
    this.failures = 0;
    metricCircuitBreakerState.set({ entity: PREFIX }, 0);
  },

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD && this.state !== 'OPEN') {
      this.state = 'OPEN';
      metricCircuitBreakerState.set({ entity: PREFIX }, 2);
      metricCircuitBreakerOpenings.inc({ entity: PREFIX });
      process.stderr.write(`[${PREFIX}] Circuit breaker OPEN after ${this.failures} consecutive failures - failing fast for ${CIRCUIT_BREAKER_RESET_MS}ms\n`);
    }
  },
};

// ---------------------------------------------------------------------------
// CRM communication
// ---------------------------------------------------------------------------
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
        catch { reject(new Error(`Non-JSON (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`)); }
      });
    });
    req.setTimeout(CRM_REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
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
      e.code = r.number;
      throw e;
    }
    end();
    return r;
  } catch (err) {
    end();
    throw err;
  }
}

async function crmLogin(user, pass) {
  const r = await rawCall('login', {
    user_auth: { user_name: user, password: createHash('md5').update(pass).digest('hex') },
    application_name: 'SuiteCRM-MCP-Gateway',
    name_value_list: [],
  });
  if (!r.id || r.id === 0 || r.id === '0')
    throw new Error(`CRM login failed for "${user}": ${r.description || r.name || 'Invalid Login'}`);
  return r.id;
}

async function ensureCrmSession(sid) {
  if (crmSessions.has(sid)) return crmSessions.get(sid);
  const creds = connCreds.get(sid);
  if (!creds) throw new Error(`No credentials found for session ${sid.slice(0, 8)}`);
  const crmSid = await crmLogin(creds.user, creds.pass);
  crmSessions.set(sid, crmSid);
  process.stderr.write(`[${PREFIX}] CRM session opened for "${creds.user}" (sid=${sid.slice(0,8)})\n`);
  return crmSid;
}

async function crmCall(sid, method, params) {
  if (circuitBreaker.isOpen())
    throw new Error(`Circuit breaker open - CRM unavailable (${circuitBreaker.failures} consecutive failures)`);

  let crmSid = await ensureCrmSession(sid);
  try {
    const result = await rawCall(method, { session: crmSid, ...params });
    circuitBreaker.recordSuccess();
    return result;
  } catch (err) {
    // Session expiry (code 11) is expected, not a circuit breaker failure
    if (err.code === 11) {
      process.stderr.write(`[${PREFIX}] Session expired - re-logging in\n`);
      metricSessionRenewals.inc({ entity: PREFIX });
      crmSessions.delete(sid);
      crmSid = await ensureCrmSession(sid);
      const result = await rawCall(method, { session: crmSid, ...params });
      circuitBreaker.recordSuccess();
      return result;
    }
    circuitBreaker.recordFailure();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Utility
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
function flatList(el) { return (el || []).map(e => flatNvl(e.name_value_list || e)); }
function toNvl(obj) { return Object.entries(obj).map(([n, v]) => ({ name: n, value: String(v ?? '') })); }

// Defense-in-depth: reject queries containing destructive SQL keywords.
// SuiteCRM's API expects a raw WHERE clause, so we allow SELECT-style predicates
// but block anything that could mutate data or schema.
const BLOCKED_SQL = /\b(DROP|ALTER|TRUNCATE|INSERT|UPDATE|DELETE|EXEC|EXECUTE|CREATE|GRANT|REVOKE|UNION\s+SELECT|INTO\s+OUTFILE|LOAD_FILE|BENCHMARK|SLEEP)\b/i;
const BLOCKED_PATTERNS = /;|--|\/\*|\*\//;
function sanitizeQuery(q) {
  if (!q) return q;
  if (BLOCKED_SQL.test(q))
    throw new McpError(ErrorCode.InvalidParams, 'Query contains blocked SQL keyword');
  if (BLOCKED_PATTERNS.test(q))
    throw new McpError(ErrorCode.InvalidParams, 'Query contains disallowed characters (;, --, or block comments)');
  return q;
}

// Module names in SuiteCRM are PascalCase identifiers (e.g. Accounts, AOS_Quotes).
const SAFE_MODULE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
function validateModule(m) {
  if (!m || !SAFE_MODULE.test(m))
    throw new McpError(ErrorCode.InvalidParams, `Invalid module name: ${String(m).slice(0, 40)}`);
}

// SuiteCRM uses UUID-format IDs (lowercase hex with hyphens).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateId(id) {
  if (!id || !UUID_RE.test(id))
    throw new McpError(ErrorCode.InvalidParams, `Invalid record ID format: ${String(id).slice(0, 40)}`);
}

// SuiteCRM link field names are snake_case identifiers (e.g. contacts, member_of).
const SAFE_LINK_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
function validateLinkField(f) {
  if (!f || !SAFE_LINK_FIELD.test(f))
    throw new McpError(ErrorCode.InvalidParams, `Invalid link_field: ${String(f).slice(0, 40)}`);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
async function searchRecords(sid, { module, query='', fields=[], max_results=20, offset=0, order_by='' }) {
  validateModule(module);
  sanitizeQuery(query);
  if (order_by) sanitizeQuery(order_by);
  const r = await crmCall(sid, 'get_entry_list', {
    module_name: module, query, order_by, offset, select_fields: fields,
    link_name_to_fields_array: [], max_results: Math.min(max_results, MAX_SEARCH_RESULTS),
    deleted: 0, favorites: false,
  });
  return {
    module, records: flatList(r.entry_list),
    result_count: r.result_count || 0,
    total_count: parseInt(r.total_count || '0', 10),
    next_offset: r.next_offset || 0,
  };
}

async function searchText(sid, { search_string, modules=['Accounts','Contacts','Leads'], max_results=10 }) {
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
    module_name: module,
    name_value_list: [{ name: 'id', value: id }, ...toNvl(fields)],
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
  validateModule(module);
  sanitizeQuery(query);
  const r = await crmCall(sid, 'get_entries_count', { module_name: module, query, deleted: 0 });
  return { module, count: parseInt(r.result_count || '0', 10) };
}

async function getRelationships(sid, { module, id, link_field, related_fields=[], max_results=20, offset=0 }) {
  validateModule(module); validateId(id); validateLinkField(link_field);
  const r = await crmCall(sid, 'get_relationships', {
    module_name: module, module_id: id, link_field_name: link_field,
    related_module_query: '', related_fields,
    related_module_link_name_to_fields_array: [],
    deleted: 0, order_by: '', offset, limit: max_results,
  });
  return { records: flatList(r.entry_list), count: (r.entry_list || []).length };
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
    fields: Object.values(r.module_fields || {}).map(f => ({
      name: f.name, type: f.type, label: f.label, required: f.required,
      options: f.options ? Object.keys(f.options) : undefined,
    })),
    relationships: (r.link_fields || []).map(l => ({ name: l.name, related_module: l.module })),
  };
}

async function listModules(sid) {
  const r = await crmCall(sid, 'get_available_modules', { filter: 'all' });
  return (r.modules || []).map(m => ({ key: m.module_key, label: m.module_label }));
}

async function serverInfo(sid) {
  const creds = connCreds.get(sid) || {};
  return {
    prefix: PREFIX, port: PORT, endpoint: ENDPOINT.replace(/^(https?:\/\/[^/]+).*/, '$1'),
    crm_user: creds.user || '?',
    session_active: crmSessions.has(sid),
    active_connections: transports.size,
    circuit_breaker: circuitBreaker.state.toLowerCase(),
  };
}

const MODULE_LIST = ['Accounts','Contacts','Leads','Opportunities','Cases',
  'Calls','Meetings','Tasks','Notes','Emails','Documents','Campaigns',
  'AOS_Quotes','AOS_Invoices','AOS_Products','AOS_Contracts',
  'AOR_Reports','AOW_WorkFlow','SecurityGroups'].join(', ');

const TOOLS = [
  { name: `${PREFIX}_search`, description: `Search records in any SuiteCRM module using a SQL WHERE clause. Modules: ${MODULE_LIST}.`,
    inputSchema: { type:'object', required:['module'], properties: {
      module: {type:'string'}, query: {type:'string'}, fields: {type:'array', items:{type:'string'}},
      max_results: {type:'number'}, offset: {type:'number'}, order_by: {type:'string'}}}},
  { name: `${PREFIX}_search_text`, description: 'Full-text search across Accounts, Contacts, Leads (or specified modules).',
    inputSchema: { type:'object', required:['search_string'], properties: {
      search_string: {type:'string'}, modules: {type:'array', items:{type:'string'}}, max_results: {type:'number'}}}},
  { name: `${PREFIX}_get`, description: 'Get a single record by UUID.',
    inputSchema: { type:'object', required:['module','id'], properties: {
      module: {type:'string'}, id: {type:'string'}, fields: {type:'array', items:{type:'string'}}}}},
  { name: `${PREFIX}_create`, description: 'Create a new record.',
    inputSchema: { type:'object', required:['module','fields'], properties: {
      module: {type:'string'}, fields: {type:'object', additionalProperties:{type:'string'}}}}},
  { name: `${PREFIX}_update`, description: 'Update an existing record.',
    inputSchema: { type:'object', required:['module','id','fields'], properties: {
      module: {type:'string'}, id: {type:'string'}, fields: {type:'object', additionalProperties:{type:'string'}}}}},
  { name: `${PREFIX}_delete`, description: 'Soft-delete a record (sets deleted=1).',
    inputSchema: { type:'object', required:['module','id'], properties: {module: {type:'string'}, id: {type:'string'}}}},
  { name: `${PREFIX}_count`, description: 'Count records matching a query.',
    inputSchema: { type:'object', required:['module'], properties: {module: {type:'string'}, query: {type:'string'}}}},
  { name: `${PREFIX}_get_relationships`, description: 'Get related records via a link field.',
    inputSchema: { type:'object', required:['module','id','link_field'], properties: {
      module: {type:'string'}, id: {type:'string'}, link_field: {type:'string'},
      related_fields: {type:'array', items:{type:'string'}}, max_results: {type:'number'}, offset: {type:'number'}}}},
  { name: `${PREFIX}_link_records`, description: 'Create a relationship between two records.',
    inputSchema: { type:'object', required:['module','id','link_field','related_ids'], properties: {
      module: {type:'string'}, id: {type:'string'}, link_field: {type:'string'}, related_ids: {type:'array', items:{type:'string'}}}}},
  { name: `${PREFIX}_unlink_records`, description: 'Remove a relationship between records.',
    inputSchema: { type:'object', required:['module','id','link_field','related_ids'], properties: {
      module: {type:'string'}, id: {type:'string'}, link_field: {type:'string'}, related_ids: {type:'array', items:{type:'string'}}}}},
  { name: `${PREFIX}_get_module_fields`, description: 'Get field definitions and relationships for a module.',
    inputSchema: { type:'object', required:['module'], properties: {module: {type:'string'}}}},
  { name: `${PREFIX}_list_modules`, description: 'List all available CRM modules.',
    inputSchema: { type:'object', properties:{}}},
  { name: `${PREFIX}_server_info`, description: 'Show gateway status and connection info.',
    inputSchema: { type:'object', properties:{}}},
];

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------
function createMcpServer(sid) {
  const srv = new Server({name:`suitecrm-gateway-${PREFIX}`, version: PKG_VERSION}, {capabilities:{tools:{}}});
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const end = metricToolDuration.startTimer({ entity: PREFIX, tool: name });
    try {
      let result;
      switch (name) {
        case `${PREFIX}_search`:           result = await searchRecords(sid, args); break;
        case `${PREFIX}_search_text`:      result = await searchText(sid, args); break;
        case `${PREFIX}_get`:              result = await getRecord(sid, args); break;
        case `${PREFIX}_create`:           result = await createRecord(sid, args); break;
        case `${PREFIX}_update`:           result = await updateRecord(sid, args); break;
        case `${PREFIX}_delete`:           result = await deleteRecord(sid, args); break;
        case `${PREFIX}_count`:            result = await countRecords(sid, args); break;
        case `${PREFIX}_get_relationships`:result = await getRelationships(sid, args); break;
        case `${PREFIX}_link_records`:     result = await linkRecords(sid, args); break;
        case `${PREFIX}_unlink_records`:   result = await unlinkRecords(sid, args); break;
        case `${PREFIX}_get_module_fields`:result = await getModuleFields(sid, args); break;
        case `${PREFIX}_list_modules`:     result = await listModules(sid); break;
        case `${PREFIX}_server_info`:      result = await serverInfo(sid); break;
        default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      end();
      metricToolCalls.inc({ entity: PREFIX, tool: name, status: 'success' });
      return { content: [{ type:'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      end();
      metricToolCalls.inc({ entity: PREFIX, tool: name, status: 'error' });
      const msg = [err.message, err.description].filter(Boolean).join(' - ');
      return { content: [{ type:'text', text:`Error: ${msg}` }], isError: true };
    }
  });
  return srv;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Trust one level of reverse proxy (nginx) so that req.ip resolves to the
// real client IP from X-Forwarded-For instead of 127.0.0.1.
// Only enabled when TRUST_PROXY=1 is set by the installer - which it sets only
// when nginx is actually in front (--domain on single, always on multi).
// Direct single-port access leaves this unset so clients cannot spoof their IP.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// CORS: no Access-Control-Allow-Origin header is set.
// MCP clients (Claude Desktop, Claude Code) are not browsers and don't require CORS.
// Omitting the header means browsers enforce the same-origin policy by default,
// blocking cross-origin requests including those from Origin: null contexts.
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  if (req.path === '/messages') {
    next();
  } else {
    bodyParser.json()(req, res, next);
  }
});

// Shallow health - fast, no external calls. Use for liveness probes.
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  version: PKG_VERSION,
  prefix: PREFIX,
  uptime: Math.floor(process.uptime()),
  connections: transports.size,
  circuit_breaker: circuitBreaker.state.toLowerCase(),
}));

// Deep health - tests actual CRM reachability. Use for readiness probes.
app.get('/health/deep', async (_req, res) => {
  const start = Date.now();
  const checks = {};
  let status = 'healthy';

  // Check endpoint URL is parseable
  try {
    const parsed = new URL(ENDPOINT);
    checks.endpoint = { status: 'ok', url: `${parsed.protocol}//${parsed.host}` };
  } catch {
    checks.endpoint = { status: 'error', message: 'Invalid endpoint URL' };
    status = 'unhealthy';
  }

  // Check CRM API responds (get_server_info requires no auth)
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
    version: PKG_VERSION,
    prefix: PREFIX,
    uptime: Math.floor(process.uptime()),
    connections: transports.size,
    circuit_breaker: circuitBreaker.state.toLowerCase(),
    checks,
    duration_ms: Date.now() - start,
  });
});

const authRateLimit = rateLimit({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts - try again in 15 minutes' },
});

app.get('/test', authRateLimit, async (req, res) => {
  const user = (req.headers['x-crm-user'] || '').trim();
  const pass = (req.headers['x-crm-pass'] || '').trim();
  if (!user || !pass) {
    return res.status(400).json({ error: 'X-CRM-User and X-CRM-Pass headers required' });
  }
  try {
    await crmLogin(user, pass);
    res.json({ success: true, crm_user: user, prefix: PREFIX });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/sse', authRateLimit, async (req, res) => {
  const user = (req.headers['x-crm-user'] || '').trim();
  const pass = (req.headers['x-crm-pass'] || '').trim();
  if (!user || !pass) {
    return res.status(401).json({ error: 'X-CRM-User and X-CRM-Pass headers required' });
  }
  // For multi-entity nginx routing, SUITECRM_CODE routes /messages back through nginx correctly.
  // Leave blank (single-entity) and the messages endpoint is just /messages.
  const CODE = process.env.SUITECRM_CODE || '';
  const msgPath = CODE ? `/${CODE}/messages` : '/messages';
  const transport = new SSEServerTransport(msgPath, res);
  const sid = transport.sessionId;
  connCreds.set(sid, { user, pass });
  try {
    await ensureCrmSession(sid);
  } catch (err) {
    connCreds.delete(sid);
    metricAuthFailures.inc({ entity: PREFIX });
    process.stderr.write(`[${PREFIX}] CRM login failed for "${user}": ${err.message}\n`);
    return res.status(401).json({ error: `CRM authentication failed: ${err.message}` });
  }
  const srv = createMcpServer(sid);
  transports.set(sid, transport);
  metricActiveConnections.set({ entity: PREFIX }, transports.size);
  metricConnections.inc({ entity: PREFIX });
  res.on('close', () => {
    transports.delete(sid);
    crmSessions.delete(sid);
    connCreds.delete(sid);
    metricActiveConnections.set({ entity: PREFIX }, transports.size);
    process.stderr.write(`[${PREFIX}] Disconnected: "${user}" (sid=${sid.slice(0,8)})\n`);
  });
  await srv.connect(transport);
  process.stderr.write(`[${PREFIX}] Connected: "${user}" (sid=${sid.slice(0,8)})\n`);
});

const messagesRateLimit = rateLimit({
  windowMs: TOOL_RATE_LIMIT_WINDOW_MS,
  max: TOOL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many tool calls - slow down' },
});

app.post('/messages', messagesRateLimit, async (req, res) => {
  const sid = req.query.sessionId;
  const t = transports.get(sid);
  if (!t) {
    return res.status(404).json({ error: `Session not found: ${sid}` });
  }
  await t.handlePostMessage(req, res);
});

process.on('SIGTERM', () => {
  process.stderr.write(`[${PREFIX}] SIGTERM received - shutting down\n`);
  for (const [, t] of transports) t.close?.();
  process.exit(0);
});

app.listen(PORT, BIND_HOST, (err) => {
  if (err) {
    process.stderr.write(`[${PREFIX}] FATAL: Failed to start server: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`[${PREFIX}] Gateway listening on ${BIND_HOST}:${PORT}\n`);
  process.stderr.write(`[${PREFIX}] CRM endpoint: ${ENDPOINT}\n`);
  if (!TLS_OK) process.stderr.write(`[${PREFIX}] WARNING: TLS verification disabled\n`);
  if (!ENDPOINT.startsWith('https://'))
    process.stderr.write(`[${PREFIX}] WARNING: CRM endpoint is not HTTPS - passwords are sent as MD5 hashes over plaintext\n`);
});

// ---------------------------------------------------------------------------
// Metrics server - separate port, never exposed through nginx
// Binds to 127.0.0.1 by default (systemd installs). Set METRICS_BIND=0.0.0.0
// when running in Docker so Prometheus can reach it from another container.
// ---------------------------------------------------------------------------
const METRICS_BIND = process.env.METRICS_BIND || '127.0.0.1';
const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
    res.end(await metricsRegistry.metrics());
  } else {
    res.writeHead(404);
    res.end();
  }
});
metricsServer.listen(METRICS_PORT, METRICS_BIND, () => {
  process.stderr.write(`[${PREFIX}] Metrics listening on ${METRICS_BIND}:${METRICS_PORT}/metrics\n`);
});
