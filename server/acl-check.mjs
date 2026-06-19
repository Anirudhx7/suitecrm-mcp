import mysql from 'mysql2/promise';

// =============================================================================
// GATEWAY ACL DESIGN - FINAL (do not change without understanding the tradeoffs)
// =============================================================================
//
// PURPOSE
//   The gateway ACL is a defence-in-depth layer that enforces SuiteCRM's own
//   permission tables *before* a write reaches the CRM API. It is NOT the only
//   enforcer - the CRM API also checks permissions. The gateway layer exists so
//   that a denied write is rejected early, without touching SuiteCRM at all.
//
// WHAT IS CHECKED
//   Only destructive / mutating operations are checked (create, edit, delete).
//   Read operations (list, view / search, get, get_many, etc.) are NOT checked
//   here - the CRM API enforces read ACL natively and those checks are redundant
//   at the gateway layer.
//
// HOW THE CHECK WORKS (live DB, no cache)
//   On every write tool call, the gateway queries the live SuiteCRM MySQL DB:
//     1. Resolve the CRM username → UUID + is_admin flag (single query).
//     2. If is_admin = 1 → allow immediately (admins bypass all ACL).
//     3. Compute effective permission = MAX(access_override) across all roles
//        (direct + via security group) for the user+module+action triple.
//     4. MAX follows SuiteCRM semantics: most permissive role wins.
//     5. effective = ACL_DENY_ALL     → DENY
//        effective = ACL_ALLOW_DISABLED → DENY
//        effective = ACL_ALLOW_OWNER  → Owner check: fetch assigned_user_id from
//                                       the module table; deny if not the requester.
//        effective ≥ ACL_ALLOW_GROUP  → allow (Group, All)
//        effective = 0 / no rows      → default, allow
//
//   There is NO Redis caching of ACL data. Every write hits the live DB so that
//   any permission change made in the SuiteCRM Web UI takes effect on the very
//   next API call - no restarts, no cache flushes, no sync jobs required.
//
// FAILURE BEHAVIOUR
//   - ACL DB not configured (no SUITECRM_DB_HOST)  → allow (entity has no ACL)
//   - DB unreachable, read operation               → allow (CRM handles reads)
//   - DB unreachable, write operation              → DENY
//     Writes are never assumed safe. If the gateway cannot confirm the user is
//     permitted to write, it refuses. This prevents a DB outage from becoming
//     an unintended permission escalation for write operations.
//
// DECISION TABLE
//   Condition                                    | Result
//   ---------------------------------------------|--------
//   No DB configured                             | allow
//   Read action (list / view)                    | allow (not checked)
//   User is SuiteCRM admin (is_admin=1)          | allow
//   effective = ACL_DENY_ALL     (-99)           | DENY
//   effective = ACL_ALLOW_DISABLED (-98)         | DENY
//   effective = ACL_ALLOW_OWNER  + user is owner | allow
//   effective = ACL_ALLOW_OWNER  + not owner     | DENY
//   effective = ACL_ALLOW_OWNER  + create action | allow (creator owns it)
//   effective ≥ ACL_ALLOW_GROUP                  | allow
//   effective = 0 or no rows                     | allow
//   DB unreachable + write                       | DENY
//
// ACL CONSTANT VALUES
//   Standard SuiteCRM:  ACL_ALLOW_ALL=89, ACL_ALLOW_GROUP=79, ACL_ALLOW_OWNER=69
//   Some installs override these in actiondefs.override.php. Check your install's
//   modules/ACLActions/actiondefs.php (or actiondefs.override.php) and set the
//   ACL_ALLOW_* env vars in your entity .env file if they differ from the defaults.
// =============================================================================

// Action mapping: MCP tool action → SuiteCRM acl_actions.name value
export const ACTION_MAP = { create: 'create', update: 'edit', delete: 'delete', list: 'list', view: 'view' };

// Only these SuiteCRM action names trigger a live DB check.
const WRITE_ACTIONS = new Set(['create', 'edit', 'delete']);

// ACL permission level constants - configurable per entity via env vars.
// Defaults match standard SuiteCRM. Override if your install uses different values
// (check modules/ACLActions/actiondefs.php or actiondefs.override.php).
let ACL_ALLOW_ALL      = 89;
let ACL_ALLOW_GROUP    = 79;
let ACL_ALLOW_OWNER    = 69;
let ACL_ALLOW_DISABLED = -98;
const ACL_DENY_ALL = -99;

// MySQL pool - null when SUITECRM_DB_HOST is not set (ACL disabled for this entity).
let pool = null;

export function initAclDb() {
  const host = (process.env.SUITECRM_DB_HOST || '').trim();
  if (!host) return;
  pool = mysql.createPool({
    host,
    port:               parseInt(process.env.SUITECRM_DB_PORT || '3306', 10),
    database:           (process.env.SUITECRM_DB_NAME || '').trim(),
    user:               (process.env.SUITECRM_DB_USER || '').trim(),
    password:           (process.env.SUITECRM_DB_PASS || '').trim(),
    waitForConnections: true,
    connectionLimit:    5,
    connectTimeout:     5000,
  });
  // Load ACL constants after env is available
  ACL_ALLOW_ALL      = parseInt(process.env.ACL_ALLOW_ALL      || '89', 10);
  ACL_ALLOW_GROUP    = parseInt(process.env.ACL_ALLOW_GROUP    || '79', 10);
  ACL_ALLOW_OWNER    = parseInt(process.env.ACL_ALLOW_OWNER    || '69', 10);
  ACL_ALLOW_DISABLED = parseInt(process.env.ACL_ALLOW_DISABLED || '-98', 10);
}

// Returns true if the user is DENIED this action on this module.
// recordId is required for owner checks on edit/delete - pass null for create.
export async function isAclDenied(crmUsername, module, aclAction, recordId = null) {
  if (!pool) return false;
  if (!WRITE_ACTIONS.has(aclAction)) return false;

  try {
    // Resolve username → UUID and admin flag in one live query (no cache).
    const [userRows] = await pool.query(
      'SELECT id, is_admin FROM users WHERE user_name = ? AND deleted = 0 LIMIT 1',
      [crmUsername]
    );
    if (!userRows.length) return false;
    if (userRows[0].is_admin == 1) return false; // SuiteCRM admins bypass all ACL

    const userId = userRows[0].id;

    // Effective permission = MAX(access_override) across directly assigned roles
    const [rows1] = await pool.query(`
      SELECT MAX(ara.access_override) AS eff
      FROM acl_roles_actions ara
      JOIN acl_actions aa      ON ara.action_id = aa.id
      JOIN acl_roles_users aru ON ara.role_id   = aru.role_id
      WHERE aru.user_id   = ?
        AND aa.category   = ?
        AND aa.name       = ?
        AND ara.deleted   = 0
    `, [userId, module, aclAction]);

    // Effective permission = MAX(access_override) via security group membership
    const [rows2] = await pool.query(`
      SELECT MAX(ara.access_override) AS eff
      FROM acl_roles_actions ara
      JOIN acl_actions aa                ON ara.action_id         = aa.id
      JOIN securitygroups_acl_roles sgar ON ara.role_id           = sgar.role_id
      JOIN securitygroups_users sgu      ON sgar.securitygroup_id = sgu.securitygroup_id
      WHERE sgu.user_id   = ?
        AND aa.category   = ?
        AND aa.name       = ?
        AND ara.deleted   = 0
    `, [userId, module, aclAction]);

    const effDirect = rows1[0].eff;
    const effGroup  = rows2[0].eff;

    // No ACL rows at all → default allow
    if (effDirect === null && effGroup === null) return false;

    // Most permissive role wins (SuiteCRM semantics)
    const effective = Math.max(effDirect ?? -Infinity, effGroup ?? -Infinity);

    // Explicit deny or disabled
    if (effective === ACL_DENY_ALL || effective === ACL_ALLOW_DISABLED) return true;

    // Owner: user may only edit/delete records they own
    if (effective === ACL_ALLOW_OWNER && aclAction !== 'create') {
      if (!recordId) return false; // no record ID available → let CRM enforce
      const tableName = module.toLowerCase();
      if (!/^[a-z_]+$/.test(tableName)) return false; // safety guard on table name
      const [ownerRows] = await pool.query(
        'SELECT assigned_user_id FROM ?? WHERE id = ? AND deleted = 0 LIMIT 1',
        [tableName, recordId]
      );
      if (!ownerRows.length) return false; // record not found → let CRM handle
      return ownerRows[0].assigned_user_id !== userId;
    }

    return false; // ACL_ALLOW_GROUP, ACL_ALLOW_ALL, 0=default → allow

  } catch (err) {
    const entity = (process.env.SUITECRM_CODE || '?').trim();
    console.warn(`[acl] DB unavailable for ${entity} ${module}:${aclAction} (${err.code || 'DB_ERROR'})`);
    return true; // write fail-closed: cannot confirm permission → deny
  }
}
