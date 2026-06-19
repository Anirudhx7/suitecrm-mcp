import https from 'https';
import http from 'http';
import { createHash } from 'crypto';

/**
 * Legacy REST API Bridge (v4.1)
 * Identical to 0-apiv8/server/bridges/legacy.mjs - no Redis changes needed here.
 * Session IDs are passed in/out by index.mjs which manages Redis persistence.
 */
export class LegacyBridge {
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint;
    this.logger = options.logger;
    this.tlsOk = options.tlsOk !== false;
    this.timeout = options.timeout || 30000;
    this.metrics = options.metrics || {};
  }

  postForm(url, params) {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams(params).toString();
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + parsed.search, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, rejectUnauthorized: this.tlsOk }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error(`Non-JSON: ${raw.slice(0,300)}`)); } });
      });
      req.setTimeout(this.timeout, () => req.destroy(new Error('Timeout')));
      req.on('error', reject); req.write(body); req.end();
    });
  }

  async rawCall(method, restData) {
    const end = this.metrics.startTimer?.({ method }) || (() => {});
    try {
      const r = await this.postForm(this.endpoint, { method, input_type: 'JSON', response_type: 'JSON', rest_data: JSON.stringify(restData) });
      if (r && typeof r.number === 'number' && r.number !== 0) { const e = new Error(r.name || r.description || `CRM error ${r.number}`); e.code = r.number; throw e; }
      return r;
    } catch (err) { this.metrics.recordError?.(method, err); throw err; }
    finally { end(); }
  }

  flatNvl(nvl) { if (!nvl || typeof nvl !== 'object') return {}; const out = {}; for (const k of Object.keys(nvl)) { const v = nvl[k]; out[k] = (v && typeof v === 'object' && 'value' in v) ? v.value : v; } return out; }
  flatList(el) { return (el || []).map(e => this.flatNvl(e.name_value_list || e)); }
  toNvl(obj) { return Object.entries(obj).map(([n, v]) => ({ name: n, value: String(v ?? '') })); }

  async login(user, pass) {
    const r = await this.rawCall('login', { user_auth: { user_name: user, password: createHash('md5').update(pass).digest('hex') }, application_name: 'SuiteCRM-MCP', name_value_list: [] });
    if (!r.id || r.id === 0 || r.id === '0') throw new Error(`Login failed for ${user}`);
    return r.id;
  }

  async searchRecords(sid, { module, query='', fields=[], max_results=20, offset=0, order_by='' }) {
    const r = await this.rawCall('get_entry_list', { session: sid, module_name: module, query, order_by, offset, select_fields: fields, link_name_to_fields_array: [], max_results, deleted: 0, favorites: false });
    return { module, records: this.flatList(r.entry_list), result_count: r.result_count || 0, total_count: parseInt(r.total_count || '0', 10), next_offset: r.next_offset || 0 };
  }

  async searchText(sid, { search_string, modules=['Accounts','Contacts','Leads'], max_results=10 }) {
    const r = await this.rawCall('search_by_module', { session: sid, search_string, modules, offset: 0, max_results, assigned_user_id: '', select_fields: [], unified_search_only: false, favorites: false });
    const out = {};
    for (const e of (r.entry_list || [])) out[e.name] = (e.records || []).map(rec => this.flatNvl(rec));
    return out;
  }

  async getRecord(sid, { module, id, fields=[] }) {
    const r = await this.rawCall('get_entry', { session: sid, module_name: module, id, select_fields: fields, link_name_to_fields_array: [], track_view: false });
    const recs = this.flatList(r.entry_list); return recs.length ? recs[0] : null;
  }

  async createRecord(sid, { module, fields }) { const r = await this.rawCall('set_entry', { session: sid, module_name: module, name_value_list: this.toNvl(fields) }); return { id: r.id, module, created: true }; }
  async updateRecord(sid, { module, id, fields }) { const r = await this.rawCall('set_entry', { session: sid, module_name: module, name_value_list: [{ name: 'id', value: id }, ...this.toNvl(fields)] }); return { id: r.id, module, updated: true }; }
  async deleteRecord(sid, { module, id }) { const r = await this.rawCall('set_entry', { session: sid, module_name: module, name_value_list: [{ name: 'id', value: id }, { name: 'deleted', value: '1' }] }); return { id: r.id, module, deleted: true }; }
  async countRecords(sid, { module, query='' }) { const r = await this.rawCall('get_entries_count', { session: sid, module_name: module, query, deleted: 0 }); return { module, count: parseInt(r.result_count || '0', 10) }; }

  async getRelationships(sid, { module, id, link_field, related_fields=[], max_results=20, offset=0 }) {
    const r = await this.rawCall('get_relationships', { session: sid, module_name: module, module_id: id, link_field_name: link_field, related_module_query: '', related_fields, related_module_link_name_to_fields_array: [], deleted: 0, order_by: '', offset, limit: max_results });
    return { records: this.flatList(r.entry_list), count: (r.entry_list || []).length };
  }

  async linkRecords(sid, { module, id, link_field, related_ids }) { const r = await this.rawCall('set_relationship', { session: sid, module_name: module, module_id: id, link_field_name: link_field, related_ids, name_value_list: [], delete: 0 }); return { created: r.created, failed: r.failed }; }
  async unlinkRecords(sid, { module, id, link_field, related_ids }) { const r = await this.rawCall('set_relationship', { session: sid, module_name: module, module_id: id, link_field_name: link_field, related_ids, name_value_list: [], delete: 1 }); return { deleted: r.deleted, failed: r.failed }; }

  async getModuleFields(sid, { module }) {
    const r = await this.rawCall('get_module_fields', { session: sid, module_name: module, fields: [] });
    return { module: r.module_name, table: r.table_name, fields: Object.values(r.module_fields || {}).map(f => ({ name: f.name, type: f.type, label: f.label, required: f.required, options: f.options ? Object.keys(f.options) : undefined })), relationships: Object.values(r.link_fields || {}).map(l => ({ name: l.name, related_module: l.module })) };
  }

  async listModules(sid) { const r = await this.rawCall('get_available_modules', { session: sid, filter: 'all' }); return (r.modules || []).map(m => ({ key: m.module_key, label: m.module_label })); }
  async getMany(sid, { module, ids, fields=[] }) { const r = await this.rawCall('get_entries', { session: sid, module_name: module, ids, select_fields: fields, link_name_to_fields_array: [] }); return { module, records: this.flatList(r.entry_list), count: (r.entry_list || []).length }; }
  async bulkUpsert(sid, { module, records }) { const r = await this.rawCall('set_entries', { session: sid, module_name: module, name_value_lists: records.map(f => this.toNvl(f)) }); return { ids: r.ids || [], count: (r.ids || []).length }; }

  async getDropdownValues(sid, { dropdown_name } = {}) {
    const r = await this.rawCall('get_language_definition', { session: sid, modules: ['app_list_strings'], MD5: false });
    const als = r?.app_list_strings || {};
    if (dropdown_name) { if (!als[dropdown_name]) throw new Error(`Dropdown not found: ${dropdown_name}`); return { dropdown_name, values: als[dropdown_name] }; }
    return { available_dropdowns: Object.keys(als), count: Object.keys(als).length };
  }

  async getRecent(sid, { modules=['Accounts','Contacts','Leads'], max_results=10 }) {
    const r = await this.rawCall('get_last_viewed', { session: sid, module_names: modules });
    const items = Array.isArray(r) ? r : [];
    return { items: items.slice(0, max_results).map(i => ({ id: i.id, module: i.module_name, name: i.item_summary || i.name, viewed_at: i.date_entered })), count: Math.min(items.length, max_results) };
  }

  async getNoteAttachment(sid, { id }) { const r = await this.rawCall('get_note_attachment', { session: sid, id }); const att = r.note_attachment || {}; return { id: att.id, filename: att.filename, file_mime_type: att.file_mime_type, file_base64: att.file || null }; }
  async setNoteAttachment(sid, { id, filename, file_base64, file_mime_type }) { const note = { id, filename, file: file_base64 }; if (file_mime_type) note.file_mime_type = file_mime_type; const r = await this.rawCall('set_note_attachment', { session: sid, note }); return { id: r.id, attached: true }; }
  async getUpcomingActivities(sid) { const r = await this.rawCall('get_upcoming_activities', { session: sid }); return { activities: Array.isArray(r) ? r : [], count: (Array.isArray(r) ? r : []).length }; }

  async logCall(sid, { name, status='Held', direction='Outbound', duration_hours=0, duration_minutes=15, date_start, description='', assigned_user_id, contact_ids=[], account_ids=[] }) {
    const fields = this.toNvl({ name, status, direction, duration_hours, duration_minutes, date_start, description });
    if (assigned_user_id) fields.push({ name: 'assigned_user_id', value: assigned_user_id });
    const r = await this.rawCall('set_entry', { session: sid, module_name: 'Calls', name_value_list: fields });
    const callId = r.id; const linked = { contacts: 0, accounts: 0 };
    if (contact_ids.length) { await this.rawCall('set_relationship', { session: sid, module_name: 'Calls', module_id: callId, link_field_name: 'contacts', related_ids: contact_ids, name_value_list: [], delete: 0 }); linked.contacts = contact_ids.length; }
    if (account_ids.length) { await this.rawCall('set_relationship', { session: sid, module_name: 'Calls', module_id: callId, link_field_name: 'accounts', related_ids: account_ids, name_value_list: [], delete: 0 }); linked.accounts = account_ids.length; }
    return { id: callId, module: 'Calls', created: true, linked };
  }

  async createTask(sid, { name, status='Not Started', priority='Medium', date_due, date_start, description='', assigned_user_id, contact_id, parent_type, parent_id }) {
    const nvl = this.toNvl({ name, status, priority, description });
    if (date_due) nvl.push({ name: 'date_due', value: date_due });
    if (date_start) nvl.push({ name: 'date_start', value: date_start });
    if (assigned_user_id) nvl.push({ name: 'assigned_user_id', value: assigned_user_id });
    if (contact_id) nvl.push({ name: 'contact_id', value: contact_id });
    if (parent_type) nvl.push({ name: 'parent_type', value: parent_type });
    if (parent_id) nvl.push({ name: 'parent_id', value: parent_id });
    const r = await this.rawCall('set_entry', { session: sid, module_name: 'Tasks', name_value_list: nvl });
    return { id: r.id, module: 'Tasks', created: true };
  }

  async createNote(sid, { name, description='', parent_type, parent_id, contact_id, assigned_user_id }) {
    const nvl = this.toNvl({ name, description });
    if (parent_type) nvl.push({ name: 'parent_type', value: parent_type });
    if (parent_id) nvl.push({ name: 'parent_id', value: parent_id });
    if (contact_id) nvl.push({ name: 'contact_id', value: contact_id });
    if (assigned_user_id) nvl.push({ name: 'assigned_user_id', value: assigned_user_id });
    const r = await this.rawCall('set_entry', { session: sid, module_name: 'Notes', name_value_list: nvl });
    return { id: r.id, module: 'Notes', created: true };
  }

  async getRecordActivities(sid, { module, id, types=['calls','meetings','tasks','notes'], max_results=10 }) {
    const out = {};
    for (const type of types) {
      try {
        const r = await this.rawCall('get_relationships', { session: sid, module_name: module, module_id: id, link_field_name: type, related_module_query: '', related_fields: ['id','name','status','date_start','date_due','date_entered','description'], related_module_link_name_to_fields_array: [], deleted: 0, order_by: '', offset: 0, limit: max_results });
        out[type] = this.flatList(r.entry_list);
      } catch (err) { this.logger?.warn({ type, module, id, err: err.message }, 'get_record_activities_type_failed'); out[type] = []; }
    }
    return out;
  }
}
