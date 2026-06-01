/**
 * Hybrid CRM Bridge
 * Implements a prioritized dual-API strategy (SuiteCRM 8 GraphQL + v4_1 REST fallback).
 * Ensures zero feature regression by failing back to LegacyBridge.
 * NOTE: This file is identical to 0-apiv8/server/bridges/hybrid.mjs — no changes needed.
 */
export class HybridBridge {
  constructor(v8Bridge, v4Bridge, options = {}) {
    this.v8 = v8Bridge;
    this.v4 = v4Bridge;
    this.logger = options.logger || console;
    this.priority = options.priority || 'v8';
    this.v8Healthy = null; // null = no calls yet
    this.v4Healthy = null;
  }

  async login(user, pass) {
    const sessions = { v8: null, v4: null };
    try { sessions.v8 = await this.v8.login(user, pass); }
    catch (err) { this.logger.warn({ user, err: err.message }, 'v8_login_failed_will_try_v4'); }
    try { sessions.v4 = await this.v4.login(user, pass); }
    catch (err) { this.logger.error({ user, err: err.message }, 'v4_login_failed_critical'); if (!sessions.v8) throw err; }
    return sessions;
  }

  async execute(sessions, method, params) {
    if (this.priority === 'v8' && sessions.v8 && this.v8.supports(method)) {
      try {
        const result = await this.v8[method](sessions.v8, params);
        this.v8Healthy = true;
        return result;
      } catch (err) {
        this.v8Healthy = false;
        this.logger.warn({ method, err: err.message }, 'v8_call_failed_falling_back');
      }
    }
    if (sessions.v4) {
      const result = await this.v4[method](sessions.v4, params);
      this.v4Healthy = true;
      if (this.priority === 'v8' && sessions.v8) this.logger.info({ method }, 'v4_fallback_succeeded');
      return result;
    }
    this.v4Healthy = false;
    throw new Error(`Method ${method} failed on all available API bridges.`);
  }

  async searchRecords(sessions, params)       { return this.execute(sessions, 'searchRecords', params); }
  async searchText(sessions, params)          { return this.execute(sessions, 'searchText', params); }
  async getRecord(sessions, params)           { return this.execute(sessions, 'getRecord', params); }
  async createRecord(sessions, params)        { return this.execute(sessions, 'createRecord', params); }
  async updateRecord(sessions, params)        { return this.execute(sessions, 'updateRecord', params); }
  async deleteRecord(sessions, params)        { return this.execute(sessions, 'deleteRecord', params); }
  async countRecords(sessions, params)        { return this.execute(sessions, 'countRecords', params); }
  async getRelationships(sessions, params)    { return this.execute(sessions, 'getRelationships', params); }
  async linkRecords(sessions, params)         { return this.execute(sessions, 'linkRecords', params); }
  async unlinkRecords(sessions, params)       { return this.execute(sessions, 'unlinkRecords', params); }
  async getModuleFields(sessions, params)     { return this.execute(sessions, 'getModuleFields', params); }
  async listModules(sessions)                 { return this.execute(sessions, 'listModules', {}); }
  async getMany(sessions, params)             { return this.execute(sessions, 'getMany', params); }
  async bulkUpsert(sessions, params)          { return this.execute(sessions, 'bulkUpsert', params); }
  async getDropdownValues(sessions, params)   { return this.execute(sessions, 'getDropdownValues', params); }
  async getRecent(sessions, params)           { return this.execute(sessions, 'getRecent', params); }
  async getNoteAttachment(sessions, params)   { return this.execute(sessions, 'getNoteAttachment', params); }
  async setNoteAttachment(sessions, params)   { return this.execute(sessions, 'setNoteAttachment', params); }
  async getUpcomingActivities(sessions)       { return this.execute(sessions, 'getUpcomingActivities', {}); }
  async logCall(sessions, params)             { return this.execute(sessions, 'logCall', params); }
  async createTask(sessions, params)          { return this.execute(sessions, 'createTask', params); }
  async createNote(sessions, params)          { return this.execute(sessions, 'createNote', params); }
  async getRecordActivities(sessions, params) { return this.execute(sessions, 'getRecordActivities', params); }
}
