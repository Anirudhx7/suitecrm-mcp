# SuiteCRM Side Setup

> **When to run this:** Once per CRM instance, before connecting the gateway.
> Three setup steps: enable API access per user, fix the OAuth2 token lifetime
> (default is 1 minute — too short for MCP sessions), and create the `mcp_acl_reader`
> service account (required if you enable ACL enforcement).

---

## Enable API Access for Each User

Before any user can authenticate via the gateway, their SuiteCRM account must have
API access explicitly enabled. Without this, all login attempts return `Invalid Login`
with no useful error message.

1. Log into SuiteCRM as admin
2. Go to Admin -> User Management -> (select the user)
3. Scroll to "Password" section -> tick **"Allow API Access"** -> Save

Repeat for every user who will connect via the gateway. The `mcp_acl_reader` service
account (Part 2 below) also needs this enabled.

---

## Find the REST API Endpoint

SuiteCRM's REST API path varies by installation and hosting setup.
Run this probe from your gateway server to find the right URL:

```bash
for path in \
  "/service/v4_1/rest.php" \
  "/legacy/service/v4_1/rest.php" \
  "/crm/legacy/service/v4_1/rest.php" \
  "/crm/public/legacy/service/v4_1/rest.php"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://crm.example.com${path}" \
    -d 'method=get_server_info&input_type=JSON&response_type=JSON&rest_data=%7B%7D')
  echo "$code  $path"
done
```

The first path that returns `200` is your `SUITECRM_ENDPOINT`.

> Replace `crm.example.com` with your CRM's actual hostname.

---

## Prerequisites — Collect DB Credentials

From the CRM server's `config.php`:

```bash
grep -E "db_host_name|db_name|db_user_name|db_password" /path/to/suitecrm/public/legacy/config.php
```

You'll need: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`.

> If you get a socket error when connecting, replace `localhost` with `127.0.0.1`.

---

## Part 1 — Fix OAuth2 Token Lifetime

SuiteCRM's default OAuth2 token lifetime is 1 minute. MCP sessions run for hours or days —
they will break constantly unless you extend this.

### Check current lifetime

```bash
mysql -h <DB_HOST> -u <DB_USER> -p'<DB_PASS>' <DB_NAME> -e "
SELECT id, name, duration_value, duration_amount, duration_unit
FROM oauth2clients WHERE deleted=0;"
```

If you see `duration_unit = minute` — it needs fixing.

### Set to 30 days

```bash
mysql -h <DB_HOST> -u <DB_USER> -p'<DB_PASS>' <DB_NAME> -e "
UPDATE oauth2clients
SET duration_value=30, duration_amount=30, duration_unit='day'
WHERE deleted=0;"
```

### Verify

```bash
mysql -h <DB_HOST> -u <DB_USER> -p'<DB_PASS>' <DB_NAME> -e "
SELECT id, name, duration_value, duration_amount, duration_unit
FROM oauth2clients WHERE deleted=0;"
```

Expected: `duration_unit = day`, `duration_value = 30`.

---

## Part 2 — Create `mcp_acl_reader` Service Account

Required if you enable ACL enforcement (`SUITECRM_DB_HOST` is set in the gateway env).
The gateway queries SuiteCRM's `users` and `acl_roles` tables to enforce write permissions
before forwarding tool calls to the CRM API.

### Create the user

```bash
mysql -h <DB_HOST> -u <DB_USER> -p'<DB_PASS>' <DB_NAME> -e "
INSERT INTO users (
  id, user_name, first_name, last_name,
  status, is_admin, sugar_login,
  date_entered, date_modified, deleted
) VALUES (
  UUID(), 'mcp_acl_reader', 'MCP', 'ACL Reader',
  'Active', 0, 1,
  NOW(), NOW(), 0
);"
```

### Set password

```bash
mysql -h <DB_HOST> -u <DB_USER> -p'<DB_PASS>' <DB_NAME> -e "
UPDATE users
SET user_hash=MD5('<YOUR_STRONG_PASSWORD>')
WHERE user_name='mcp_acl_reader';"
```

Use a strong random password. Add it to the gateway env as `SUITECRM_DB_PASSWORD`
(for the MySQL connection in `acl-check.mjs`) — not to be confused with the CRM user
account password.

### Verify

```bash
mysql -h <DB_HOST> -u <DB_USER> -p'<DB_PASS>' <DB_NAME> -e "
SELECT id, user_name, first_name, last_name, status, is_admin
FROM users WHERE user_name='mcp_acl_reader';"
```

Expected: `status = Active`, `is_admin = 0`.

---

## LDAP / SSO Users

SuiteCRM's v4_1 REST API only authenticates against **local database passwords**.
LDAP and SSO users have no local password and will fail to log in via the gateway.

Use `crm-provision-user` on the CRM VM (deployed by `install.py --setup-crm-host`) to set a local API password:

```bash
# SSH into the CRM VM, then:

# Single user
sudo crm-provision-user john.doe secretpassword

# Bulk from CSV (user_name,password)
sudo crm-provision-user --csv /path/to/users.csv
```

This sets a local DB password without affecting the user's LDAP/SSO login. Run it
once per LDAP user who needs gateway access.

---

## Part 3 — All-in-One Block

Run everything at once for a new CRM instance:

```bash
# Fill these in
DB_HOST="<DB_HOST>"
DB_USER="<DB_USER>"
DB_PASS="<DB_PASS>"
DB_NAME="<DB_NAME>"
MCP_PASS="<YOUR_STRONG_PASSWORD>"

# Fix token lifetime
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  UPDATE oauth2clients SET duration_value=30, duration_amount=30, duration_unit='day'
  WHERE deleted=0;"

# Create mcp_acl_reader
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  INSERT INTO users (id, user_name, first_name, last_name, status, is_admin, sugar_login, date_entered, date_modified, deleted)
  VALUES (UUID(), 'mcp_acl_reader', 'MCP', 'ACL Reader', 'Active', 0, 1, NOW(), NOW(), 0);"

# Set password
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  UPDATE users SET user_hash=MD5('$MCP_PASS') WHERE user_name='mcp_acl_reader';"

# Verify both
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  SELECT id, name, duration_value, duration_amount, duration_unit FROM oauth2clients WHERE deleted=0;
  SELECT id, user_name, first_name, last_name, status, is_admin FROM users WHERE user_name='mcp_acl_reader';"
```

---

## Token Duration Reference

| Duration  | Notes |
|-----------|-------|
| 1 minute  | SuiteCRM default — too short for MCP |
| 1 day     | Acceptable for short-lived sessions |
| **30 days** | **Recommended — matches gateway session TTL** |

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Socket connection error | `localhost` resolves to socket | Use `127.0.0.1` instead |
| `Unknown column 'user_type'` | Column absent in this SuiteCRM version | Use the INSERT above (no `user_type`) |
| `Access denied` | Wrong DB password | Re-check `db_password` in `config.php` |
| `mcp_acl_reader` already exists | Already created | Skip creation, just verify with the SELECT |
| Token lifetime reverts | SuiteCRM admin re-saved OAuth client | Re-run the UPDATE |
