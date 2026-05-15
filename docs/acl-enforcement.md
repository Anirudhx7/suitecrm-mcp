# ACL Enforcement — SuiteCRM MCP Gateway

## 1. Overview

### What problem this solves

The MCP gateway allows AI agents to call SuiteCRM tools (create, update, delete records)
on behalf of authenticated users. SuiteCRM's own ACL system restricts what each user can
do in the Web UI — but those restrictions are not checked at the CRM REST API level by
default. A user blocked from editing Tasks in the browser could still call
`suitecrm_aesg_update` with `module=Tasks` and the write would go through.

This feature closes that gap by checking SuiteCRM's live permission tables **before**
forwarding any write to the CRM API.

### How it works

Before forwarding any write tool call (create, update, delete, bulk_upsert), the gateway:

1. Opens a direct read-only MySQL connection to the CRM's own database.
2. Looks up the CRM user's internal UUID and `is_admin` flag.
3. Computes the **effective permission** = `MAX(access_override)` across all roles
   assigned to the user — both directly and via security group membership.
4. Applies SuiteCRM's "most permissive role wins" semantics to decide allow/deny.

The lookup is live (no cache) so that Web UI permission changes take effect immediately —
no restarts or cache flushes needed.

### What is and isn't enforced

**Enforced (write path):**
- `*_create` — maps to SuiteCRM ACL action `create`
- `*_update` — maps to SuiteCRM ACL action `edit`
- `*_delete` — maps to SuiteCRM ACL action `delete`
- `*_bulk_upsert` — maps to SuiteCRM ACL action `edit`
- `*_log_call`, `*_create_task`, `*_create_note` etc. — mapped to `create` on their module
- `*_link_records`, `*_unlink_records` — mapped to `edit` on the primary module

**Not enforced:**
- `*_search`, `*_get`, `*_get_many` etc. — read operations pass through; the CRM API
  enforces read-level visibility natively
- Field-level ACL — only module-level action restrictions are checked
- Record-level visibility rules beyond ownership (e.g. security group record assignment)

---

## 2. Decision Table

| Condition | Result |
|---|---|
| No DB configured (`SUITECRM_DB_HOST` not set) | allow |
| Read action (list, view, search, get) | allow (not checked) |
| User is SuiteCRM admin (`is_admin = 1`) | allow |
| effective = `ACL_DENY_ALL` (−99) | **DENY** |
| effective = `ACL_ALLOW_DISABLED` (−98) | **DENY** |
| effective = `ACL_ALLOW_OWNER` (69) + action is `create` | allow (creator owns it) |
| effective = `ACL_ALLOW_OWNER` (69) + user owns the record | allow |
| effective = `ACL_ALLOW_OWNER` (69) + user does NOT own the record | **DENY** |
| effective ≥ `ACL_ALLOW_GROUP` (79) | allow |
| effective = 0 or no rows | allow (SuiteCRM default) |
| DB unreachable + write action | **DENY** (fail-closed) |

The default constant values match standard SuiteCRM. Override them per entity via env vars
if your install uses different values (see `.env.example` and Section 5).

---

## 3. Architecture

### Request flow

```
Authenticated SSE connection (CRM username resolved from user profile)
       │
       ▼
  Tool call arrives (e.g. suitecrm_aesg_update)
       │
       ├─ Read operation (search, get, …)? ──► forward to CRM directly
       │
       ▼ Write operation
  isAclDenied(crmUsername, module, aclAction, recordId)
  [acl-check.mjs]
       │
       ├─ SUITECRM_DB_HOST not set ──► fail-open, proceed to CRM
       │
       ▼
  SELECT id, is_admin FROM users WHERE user_name = ?
       │
       ├─ not found ──► fail-open (let CRM handle unknown user)
       ├─ is_admin = 1 ──► allow immediately
       │
       ▼
  Query A: MAX(access_override) via directly assigned roles
  Query B: MAX(access_override) via security group roles
       │
       ├─ both NULL (no rows) ──► allow
       │
       ▼
  effective = MAX(A, B)
       │
       ├─ effective = -99 or -98 ──► DENY
       ├─ effective = 69 (owner) ──► owner check → allow or DENY
       ├─ effective ≥ 79 (group/all) ──► allow
       └─ effective = 0 ──► allow
```

### Key files

| File | Role |
|---|---|
| `server/acl-check.mjs` | MySQL pool, `isAclDenied()` with two MAX queries + owner check, `initAclDb()` |
| `server/index.mjs` | Calls `initAclDb()` at startup; calls `isAclDenied()` in tool call handler |
| `{entity}.env` | Per-entity config: `SUITECRM_DB_*` credentials and optional `ACL_ALLOW_*` overrides |

### Why two queries?

SuiteCRM has two ways to restrict a user's access:

1. **Direct role assignment** — via `acl_roles_users` (Query A)
2. **Security group role assignment** — role on a group, user in that group via
   `securitygroups_users` (Query B)

Both must be checked independently. Missing Query B silently skips all group-based
restrictions.

### Why MAX() instead of COUNT(*)?

The original implementation used `COUNT(*) WHERE access_override = -99` (deny-only). This
is incorrect: SuiteCRM's "most permissive role wins" rule means that if a user has one role
that denies a module and another that allows it, the allow wins. `MAX(access_override)`
across all roles returns the highest (most permissive) value, then we apply the deny
constants only if that maximum is still a deny value.

---

## 4. Failure Behaviour

| Condition | Write result | Why |
|---|---|---|
| `SUITECRM_DB_HOST` not set | allow | ACL disabled for this entity |
| DB unreachable | **DENY** | Fail-closed: cannot confirm permission |
| User not found in `users` table | allow | Let CRM enforce; unknown user will fail anyway |
| Owner check — record not found | allow | Record may be in a related table; let CRM handle |
| Owner check — no `recordId` passed | allow | Gateway can't determine ownership without an ID |

Writes are never assumed safe. If the gateway cannot confirm permission it refuses — a DB
outage is not an accidental permission escalation.

---

## 5. Configuration

### Required env vars (per entity `.env`)

```bash
SUITECRM_DB_HOST=<db_server_ip>      # LAN IP, not localhost
SUITECRM_DB_PORT=3306
SUITECRM_DB_NAME=<suitecrm_db_name>
SUITECRM_DB_USER=mcp_acl_reader      # read-only DB user (see Section 6)
SUITECRM_DB_PASS=<password>
```

### Optional ACL constant overrides

Standard SuiteCRM uses `89/79/69/−98` for `All/Group/Owner/Disabled`. Some installs
or customisations override these in `modules/ACLActions/actiondefs.override.php`.
Check your install and set env vars if they differ:

```bash
ACL_ALLOW_ALL=89       # explicit allow for all users
ACL_ALLOW_GROUP=79     # allow for group members
ACL_ALLOW_OWNER=69     # allow for record owner only
ACL_ALLOW_DISABLED=-98 # module disabled for this role
```

`ACL_DENY_ALL = -99` is always fixed and not configurable.

---

## 6. Setting Up the Read-Only DB User

The gateway connects as a **read-only** user with `SELECT` privileges only. It cannot
modify CRM data.

### Step 1 — Find the correct DB host

**Do not assume the DB is on the CRM app server.** SuiteCRM stores the DB host it uses in
`config.php`. SSH into the CRM app server and check:

```bash
grep 'db_host_name\|db_name' /path/to/suitecrm/public/legacy/config.php
```

Use that value as `SUITECRM_DB_HOST` — it may be a hostname (`internaldb.example.com`) or
a LAN IP. If it's a hostname, resolve it on the CRM server (`getent hosts <hostname>`) to
confirm the IP.

### Step 2 — Find the correct grant IP

The MySQL `GRANT` must list the IP that the gateway's connection **appears as in MySQL** —
which is not always the gateway's own IP. If there is a DB proxy (HAProxy, ProxySQL, etc.)
between the gateway and MySQL, MySQL sees the proxy's internal IP.

The fastest way to find it: attempt a connection with wrong credentials and read the error:

```bash
# From the gateway server:
node -e "
  const m = require('/opt/suitecrm-mcp/node_modules/mysql2/promise');
  m.createPool({host:'<db_host>',port:3306,database:'<db>',user:'x',password:'x',connectionLimit:1})
   .query('SELECT 1').catch(e => console.error(e.message));
"
```

The error will read `Access denied for user 'x'@'<IP>'` — that `<IP>` is what to use in
the `GRANT`.

### Step 3 — Create the user on the DB server

```bash
# Generate a password
openssl rand -base64 16

# In MySQL (as root or a privileged user):
CREATE USER 'mcp_acl_reader'@'<connecting_ip>' IDENTIFIED BY '<password>';
GRANT SELECT ON <suitecrm_db_name>.* TO 'mcp_acl_reader'@'<connecting_ip>';
FLUSH PRIVILEGES;

# Verify
SHOW GRANTS FOR 'mcp_acl_reader'@'<connecting_ip>';
```

`SELECT ON <db>.*` is intentional. The owner check needs to read `assigned_user_id` from
any module table, and module tables vary. A SELECT-only user cannot modify data regardless
of how many tables it can read.

### If multiple entities share one DB server

Create the user once, then add a `GRANT` for each database:

```sql
GRANT SELECT ON <second_db_name>.* TO 'mcp_acl_reader'@'<connecting_ip>';
FLUSH PRIVILEGES;
```

### Verify network access from the gateway

```bash
nc -zv <db_server_ip> 3306
```

If this fails with "Connection refused", MySQL is bound to `127.0.0.1`. Edit
`/etc/mysql/mysql.conf.d/mysqld.cnf` on the DB server:

```ini
bind-address = 0.0.0.0
```

Then `sudo systemctl restart mysql`.

---

## 7. Adding a New Entity

1. **Find the DB host** — SSH into the CRM app server, grep `config.php` for `db_host_name`
   and `db_name` (see Section 6 Step 1).
2. **Verify port reachability** from the gateway: `nc -zv <db_host> 3306`.
3. **Find the connecting IP** — run the probe in Section 6 Step 2 to get the IP MySQL sees.
4. **Create `mcp_acl_reader`** on the DB server (or add a GRANT if the user already exists
   for another entity on the same cluster).
5. **Check ACL constants** — on the CRM app server:
   ```bash
   grep 'ACL_ALLOW_OWNER\|ACL_ALLOW_GROUP\|ACL_ALLOW_ALL\|ACL_ALLOW_DISABLED' \
     /path/to/suitecrm/public/legacy/modules/ACLActions/actiondefs.override.php
   ```
   If the file doesn't exist or the values match `89/79/69/−98`, no overrides are needed.
   If they differ, add `ACL_ALLOW_*` env vars to the entity `.env`.
6. **Add env vars** to `/etc/suitecrm-mcp/<entity_code>.env`:
   ```bash
   SUITECRM_DB_HOST=<db_host>
   SUITECRM_DB_PORT=3306
   SUITECRM_DB_NAME=<db_name>
   SUITECRM_DB_USER=mcp_acl_reader
   SUITECRM_DB_PASS=<password>
   # Only if ACL constants differ from standard SuiteCRM:
   # ACL_ALLOW_ALL=90
   # ACL_ALLOW_GROUP=80
   # ACL_ALLOW_OWNER=75
   # ACL_ALLOW_DISABLED=-98
   ```
7. **Fix file ownership**: `chown root:root /etc/suitecrm-mcp/<entity_code>.env && chmod 640 /etc/suitecrm-mcp/<entity_code>.env`
8. **Restart** the entity service and run the verification tests below.

---

## 8. Verification Tests

Run after initial setup or any change to `acl-check.mjs` / `index.mjs`.

**Test A — restricted user write (expect: DENIED)**

Find a user with an explicit deny on a module action in the CRM:

```sql
SELECT DISTINCT u.user_name, aa.category, aa.name
FROM acl_roles_actions ara
JOIN acl_actions aa ON ara.action_id = aa.id
JOIN acl_roles_users aru ON ara.role_id = aru.role_id
JOIN users u ON aru.user_id = u.id
WHERE ara.access_override = -99 AND ara.deleted = 0
  AND aa.name IN ('edit','create','delete')
ORDER BY u.user_name, aa.category LIMIT 20;
```

Call the corresponding write tool. Response must contain `"Permission denied"` and
`"isError": true`.

**Test B — unrestricted user write (expect: SUCCESS or CRM error)**

Response must NOT contain `"Permission denied"`. A CRM-level error (record not found,
network error) is acceptable — it means ACL passed.

**Test C — any user read (expect: NOT BLOCKED)**

Call `*_search` for any module. Response must return records or a CRM error — never
`"Permission denied"`.

**Test D — live permission change**

Restrict a user in SuiteCRM Web UI → next write from that user must be blocked
immediately, without restarting the service or flushing any cache.

---

## 9. Checklist

- [ ] DB host sourced from CRM's `config.php` — not assumed to be the app server IP
- [ ] `nc -zv <db_host> 3306` succeeds from the gateway
- [ ] Connecting IP confirmed via the Section 6 Step 2 probe (especially if DB is behind a proxy)
- [ ] `mcp_acl_reader` user exists with `SELECT ON <db>.*` grant from the correct connecting IP
- [ ] ACL constants checked in `actiondefs.override.php`; `ACL_ALLOW_*` env vars added if non-standard
- [ ] `SUITECRM_DB_*` vars present in the entity `.env`
- [ ] Service starts clean: `journalctl -u suitecrm-mcp-<code> -n 20` shows `server_listening` with no MySQL errors
- [ ] Test A: restricted write → `"Permission denied"`
- [ ] Test B: unrestricted write → not denied
- [ ] Test C: read → not denied
- [ ] Test D: live Web UI permission change → immediate effect
- [ ] Service enabled on boot: `systemctl is-enabled suitecrm-mcp-<code>` → `enabled`
