import mysql from 'mysql2/promise';
import { redis } from './redis.mjs';

// Action mapping: MCP tool action → SuiteCRM ACL action name
export const ACTION_MAP = { create: 'create', update: 'edit', delete: 'delete' };

// MySQL pool — null if SUITECRM_DB_HOST not set (no ACL configured = allow).
// If pool IS configured and a DB error occurs, fail-closed: deny the write.
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
}

// Resolve CRM username → SuiteCRM internal UUID (cached in Redis 24h — UUIDs never change)
// Cache key is namespaced by entity code so cross-entity users with different UUIDs don't collide.
const ENTITY_CODE = (process.env.SUITECRM_CODE || 'unknown').trim();
async function getCrmUserId(crmUsername) {
  const cacheKey = `acl:uid:${ENTITY_CODE}:${crmUsername}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;
  const [rows] = await pool.query(
    'SELECT id FROM users WHERE user_name = ? AND deleted = 0 LIMIT 1',
    [crmUsername]
  );
  if (!rows.length) return null;
  const uid = rows[0].id;
  await redis.setex(cacheKey, 86400, uid);
  return uid;
}

// Returns true if the user is DENIED this action on this module.
// Semantics: no pool (ACL not configured) = allow; pool error (ACL misconfigured/down) = deny.
export async function isAclDenied(crmUsername, module, aclAction) {
  if (!pool) return false;
  try {
    const userId = await getCrmUserId(crmUsername);
    if (!userId) return false;

    // Check 1: Direct role restriction
    const [rows1] = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM acl_roles_actions ara
      JOIN acl_actions aa      ON ara.action_id = aa.id
      JOIN acl_roles_users aru ON ara.role_id   = aru.role_id
      WHERE aru.user_id         = ?
        AND aa.category         = ?
        AND aa.name             = ?
        AND ara.access_override = -99
        AND ara.deleted         = 0
    `, [userId, module, aclAction]);
    if (rows1[0].cnt > 0) return true;

    // Check 2: Security group role restriction
    const [rows2] = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM acl_roles_actions ara
      JOIN acl_actions aa               ON ara.action_id         = aa.id
      JOIN securitygroups_acl_roles sgar ON ara.role_id          = sgar.role_id
      JOIN securitygroups_users sgu     ON sgar.securitygroup_id = sgu.securitygroup_id
      WHERE sgu.user_id               = ?
        AND aa.category               = ?
        AND aa.name                   = ?
        AND ara.access_override       = -99
        AND ara.deleted               = 0
    `, [userId, module, aclAction]);
    return rows2[0].cnt > 0;
  } catch {
    return true; // fail-closed: ACL DB configured but unreachable — deny to be safe
  }
}
