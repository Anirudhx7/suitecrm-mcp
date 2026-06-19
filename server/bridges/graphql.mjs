export class GraphQLBridge {
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint;
    this.authEndpoint = options.authEndpoint;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.logger = options.logger;
    this.tlsOk = options.tlsOk !== false;
    this.timeout = options.timeout || 30000;
    this.metrics = options.metrics || {};
  }

  supports(method) {
    return ['searchRecords','getRecord','createRecord','updateRecord','deleteRecord','countRecords'].includes(method);
  }

  // v8Session passed as parameter (not stored on this) to avoid shared-state race condition under concurrent users
  async rawCall(v8Session, query, variables = {}) {
    const token = this._extractToken(v8Session);
    const end = this.metrics.startTimer?.({ method: 'graphql' }) || (() => {});
    try {
      const response = await fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(this.timeout) });
      if (!response.ok) { const text = await response.text(); throw new Error(`GraphQL HTTP error ${response.status}: ${text.slice(0,200)}`); }
      const result = await response.json();
      if (result.errors) throw new Error(`GraphQL Error: ${result.errors[0].message}`);
      end(); return result.data;
    } catch (err) { end(); this.metrics.recordError?.('graphql', err); throw err; }
  }

  async login(user, pass) {
    if (!this.clientId || !this.clientSecret) throw new Error('GraphQL API requires SUITECRM_CLIENT_ID and SUITECRM_CLIENT_SECRET');
    const body = { grant_type: 'password', client_id: this.clientId, client_secret: this.clientSecret, username: user, password: pass };
    const response = await fetch(this.authEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json', 'Accept': 'application/vnd.api+json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeout) });
    if (!response.ok) { const t = await response.text(); let msg = response.statusText; try { const e = JSON.parse(t); msg = e.message || e.error || msg; } catch {} throw new Error(`OAuth2 failed (${response.status}): ${msg}`); }
    const data = await response.json();
    return { token: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) };
  }

  async refreshAccess(v8Session) {
    const refreshToken = v8Session?.refreshToken;
    if (!refreshToken) throw new Error('No refresh token available');
    if (!this.clientId || !this.clientSecret) throw new Error('GraphQL API requires SUITECRM_CLIENT_ID and SUITECRM_CLIENT_SECRET');
    const body = { grant_type: 'refresh_token', client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refreshToken };
    const response = await fetch(this.authEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json', 'Accept': 'application/vnd.api+json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeout) });
    if (!response.ok) { const t = await response.text(); let msg = response.statusText; try { const e = JSON.parse(t); msg = e.message || e.error || msg; } catch {} throw new Error(`OAuth2 refresh failed (${response.status}): ${msg}`); }
    const data = await response.json();
    return { token: data.access_token, refreshToken: data.refresh_token || refreshToken, expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) };
  }

  // v8Session is { token, refreshToken, expiresAt } or a raw token string (legacy)
  _extractToken(v8Session) {
    return typeof v8Session === 'string' ? v8Session : v8Session.token;
  }

  async searchRecords(v8Session, { module, query='', fields=[], max_results=20, offset=0 }) {
    // SQL WHERE filters not supported by GraphQL v8 - throw to trigger HybridBridge fallback
    if (query && query.trim()) throw new Error('GraphQL bridge does not support SQL query filters; falling back to legacy API');
    // SuiteCRM 8.8.1: recordList query; records/meta are Iterable scalars (no sub-selection)
    const gql = `query GetRecords($module: String!, $limit: Int, $offset: Int) { recordList(module: $module, limit: $limit, offset: $offset) { records meta } }`;
    const data = await this.rawCall(v8Session, gql, { module, limit: max_results, offset });
    const rl = data.recordList;
    const records = (rl.records || []).map(r => {
      if (r && typeof r === 'object' && r.attributes) return { id: r.id || r._id, ...r.attributes };
      return r;
    });
    const meta = rl.meta || {};
    const total_count = meta?.offsets?.total ?? meta?.offsets?.total_count ?? meta?.total_count ?? -1;
    return { module, records, total_count };
  }

  async getRecord(v8Session, { module, id, fields=[] }) {
    // SuiteCRM 8.8.1: record query uses `record:` arg (not `id:`); attributes is Iterable scalar
    const gql = `query GetRecord($module: String!, $id: String!) { record(module: $module, record: $id) { id attributes } }`;
    const data = await this.rawCall(v8Session, gql, { module, id });
    if (!data.record) return null;
    return { id: data.record.id, ...(data.record.attributes || {}) };
  }

  async createRecord(v8Session, { module, fields }) {
    // SuiteCRM 8.8.1: saveRecord handles both create and update; no _id = create
    const gql = `mutation CreateRecord($module: String!, $attributes: Iterable) { saveRecord(input: { module: $module, attributes: $attributes }) { record { id } } }`;
    const data = await this.rawCall(v8Session, gql, { module, attributes: fields });
    return { id: data.saveRecord.record.id, module, created: true };
  }

  async updateRecord(v8Session, { module, id, fields }) {
    // SuiteCRM 8.8.1: saveRecord with _id = update
    const gql = `mutation UpdateRecord($module: String!, $id: String!, $attributes: Iterable) { saveRecord(input: { _id: $id, module: $module, attributes: $attributes }) { record { id } } }`;
    const data = await this.rawCall(v8Session, gql, { module, id, attributes: fields });
    return { id: data.saveRecord.record.id, module, updated: true };
  }

  async deleteRecord(v8Session, { module, id }) {
    const gql = `mutation DeleteRecord($module: String!, $id: ID!) { createProcess(input: { type: "delete", options: { module: $module, id: $id } }) { process { id status } } }`;
    const data = await this.rawCall(v8Session, gql, { module, id });
    return { id, module, deleted: data.createProcess.process.status === 'success' };
  }

  async countRecords(v8Session, { module, query='' }) {
    // SQL WHERE filters not supported by GraphQL v8 - throw to trigger HybridBridge fallback
    if (query && query.trim()) throw new Error('GraphQL bridge does not support SQL query filters; falling back to legacy API');
    const gql = `query CountRecords($module: String!) { recordList(module: $module, limit: 1) { meta } }`;
    const data = await this.rawCall(v8Session, gql, { module });
    const meta = data.recordList.meta || {};
    const count = meta?.offsets?.total ?? meta?.offsets?.total_count ?? meta?.total_count ?? 0;
    return { module, count };
  }
}
