
/**
 * SuiteCRM MCP Gateway Server (index.mjs)
 * Per-entity server (one process per entity)
 * Auth: Auth0 JWT or gateway API key
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import express from 'express';
import bodyParser from 'body-parser';
import https from 'https';
import http from 'http';

const REQUIRED = ['SUITECRM_ENDPOINT', 'SUITECRM_PREFIX', 'PORT', 'AUTH0_DOMAIN', 'AUTH0_AUDIENCE'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error(`Missing required env vars: ${missing.join(', ')}`); process.exit(1); }

const ENDPOINT = process.env.SUITECRM_ENDPOINT.trim();
const PREFIX = process.env.SUITECRM_PREFIX.trim();
const PORT = parseInt(process.env.PORT, 10);
const CODE = (process.env.SUITECRM_CODE || '').trim();
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN.trim();
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE.trim();
const REQUIRED_GROUP = (process.env.REQUIRED_GROUP || '').trim();
const PROFILES_FILE = '/etc/suitecrm-mcp/user-profiles.json';
const NS = AUTH0_AUDIENCE + '/';
const TLS_OK = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';


const transports = new Map();
const crmSessions = new Map();     // key -> sessionId
const crmSessionAges = new Map();  // key -> createdAt ms
const connCreds = new Map();
const subBySid = new Map();

const CRM_SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours
setInterval(() => {
  const cutoff = Date.now() - CRM_SESSION_TTL;
  for (const [key, at] of crmSessionAges.entries()) {
    if (at < cutoff) {
      crmSessions.delete(key);
      crmSessionAges.delete(key);
    }
  }
}, 30 * 60 * 1000).unref();

function loadProfiles() {
  try { return JSON.parse(readFileSync(PROFILES_FILE, 'utf8')); }
  catch { return {}; }
}

async function jwtMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Bearer token required' });

  // Check sessions.json first (API keys from auth service)
  try {
    const sessions = JSON.parse(readFileSync('/etc/suitecrm-mcp/sessions.json', 'utf8'));
    const session = sessions[token];
    if (session) {
      if (session.expiresAt < Date.now()) {
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
  const userGroups = req.auth[`${NS}groups`] || [];
  const hasGroup = userGroups.some(g => g.toLowerCase() === REQUIRED_GROUP.toLowerCase());
  if (!hasGroup) {
    return res.status(403).json({
      error: `Not in group "${REQUIRED_GROUP}"`,
      your_groups: userGroups,
    });
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
    req.setTimeout(30000, () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function rawCall(method, restData) {
  const r = await postForm(ENDPOINT, {
    method,
    input_type: 'JSON',
    response_type: 'JSON',
    rest_data: JSON.stringify(restData),
  });
  if (r && typeof r.number === 'number' && r.number !== 0) {
    const e = new Error(r.name || r.description || `CRM error ${r.number}`);
    e.code = r.number;
    throw e;
  }
  return r;
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
  return crmSid;
}

async function crmCall(sid, method, params) {
  let crmSid = await ensureCrmSession(sid);
  try {
    return await rawCall(method, { session: crmSid, ...params });
  } catch (err) {
    if (err.code === 11) {
      const sub = subBySid.get(sid) || sid;
      crmSessions.delete(`${sub}:${CODE}`);
      crmSessionAges.delete(`${sub}:${CODE}`);
      crmSid = await ensureCrmSession(sid);
      return await rawCall(method, { session: crmSid, ...params });
    }
    throw err;
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

async function searchRecords(sid, { module, query='', fields=[], max_results=20, offset=0, order_by='' }) {
  const r = await crmCall(sid, 'get_entry_list', {
    module_name: module,
    query,
    order_by,
    offset,
    select_fields: fields,
    link_name_to_fields_array: [],
    max_results: Math.min(max_results, 100),
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
  const r = await crmCall(sid, 'search_by_module', {
    search_string,
    modules,
    offset: 0,
    max_results,
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

async function createRecord(sid, { module, fields }) {
  const r = await crmCall(sid, 'set_entry', {
    module_name: module,
    name_value_list: toNvl(fields),
  });
  return { id: r.id, module, created: true };
}

async function updateRecord(sid, { module, id, fields }) {
  const r = await crmCall(sid, 'set_entry', {
    module_name: module,
    name_value_list: [{ name: 'id', value: id }, ...toNvl(fields)],
  });
  return { id: r.id, module, updated: true };
}

async function deleteRecord(sid, { module, id }) {
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
  const r = await crmCall(sid, 'get_entries_count', {
    module_name: module,
    query,
    deleted: 0,
  });
  return { module, count: parseInt(r.result_count || '0', 10) };
}

async function getRelationships(sid, { module, id, link_field, related_fields=[], max_results=20, offset=0 }) {
  const r = await crmCall(sid, 'get_relationships', {
    module_name: module,
    module_id: id,
    link_field_name: link_field,
    related_module_query: '',
    related_fields,
    related_module_link_name_to_fields_array: [],
    deleted: 0,
    order_by: '',
    offset,
    limit: max_results,
  });
  return {
    records: flatList(r.entry_list),
    count: (r.entry_list || []).length,
  };
}

async function linkRecords(sid, { module, id, link_field, related_ids }) {
  const ids = Array.isArray(related_ids) ? related_ids : [related_ids];
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
  const ids = Array.isArray(related_ids) ? related_ids : [related_ids];
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

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return srv;
}

const app = express();
app.use((req, res, next) =>
  req.path === '/messages' ? next() : bodyParser.json()(req, res, next)
);

app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    entity: CODE,
    port: PORT,
    active: transports.size,
  })
);

app.get('/test', jwtMiddleware, profileMiddleware, groupAccessMiddleware, async (req, res) => {
  try {
    await crmLogin(req.crmCreds.user, req.crmCreds.pass);
    res.json({ success: true, crm_user: req.crmCreds.user, entity: CODE });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/sse', jwtMiddleware, profileMiddleware, groupAccessMiddleware, async (req, res) => {
  if (transports.size >= 100) {
    return res.status(503).json({ error: 'Too many connections' });
  }

  const transport = new SSEServerTransport(`/${CODE}/messages`, res);
  const sid = transport.sessionId;
  const srv = createMcpServer(sid);

  connCreds.set(sid, req.crmCreds);
  transports.set(sid, transport);
  subBySid.set(sid, req.auth.sub);

  ensureCrmSession(sid).catch(err => {
    process.stderr.write(`[${PREFIX}] Initial CRM login failed for session ${sid}: ${err.message}\n`);
  });

  res.on('close', () => {
    transports.delete(sid);
    connCreds.delete(sid);
    subBySid.delete(sid);
  });

  await srv.connect(transport);
});

app.post('/messages', async (req, res) => {
  const t = transports.get(req.query.sessionId);
  if (!t) return res.status(404).json({ error: 'Session not found' });
  await t.handlePostMessage(req, res);
});

app.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[${PREFIX}] Listening on 127.0.0.1:${PORT}\\n`);
});
