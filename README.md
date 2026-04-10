# suitecrm-mcp

An open-source MCP (Model Context Protocol) gateway for SuiteCRM. Lets AI assistants — Claude, OpenAI, or any MCP-compatible client — read and write your CRM data over a persistent SSE connection.

Built from a real production deployment. CData's version is commercial. This one isn't.

## Features

- **13 tools** covering the full CRUD surface: search, get, create, update, delete, count, relationships, module introspection
- **SSE transport** — compatible with Claude Desktop, Claude Code, and any MCP client that supports HTTP+SSE
- **Per-connection header auth** — credentials never stored server-side; each connection supplies its own
- **Session auto-renewal** — CRM sessions re-authenticate transparently on expiry
- **Two installers** — single CRM (no nginx) or N CRMs behind nginx, both as systemd services
- **Entity-prefixed tools** — run multiple CRM instances side-by-side without name collisions

## Tools

| Tool | Description |
|------|-------------|
| `{prefix}_search` | Search records using SQL WHERE clause |
| `{prefix}_search_text` | Full-text search across modules |
| `{prefix}_get` | Get a single record by UUID |
| `{prefix}_create` | Create a new record |
| `{prefix}_update` | Update an existing record |
| `{prefix}_delete` | Soft-delete a record |
| `{prefix}_count` | Count records matching a query |
| `{prefix}_get_relationships` | Get related records via a link field |
| `{prefix}_link_records` | Create a relationship between records |
| `{prefix}_unlink_records` | Remove a relationship |
| `{prefix}_get_module_fields` | Get field definitions for a module |
| `{prefix}_list_modules` | List all available CRM modules |
| `{prefix}_server_info` | Gateway status and connection info |

Replace `{prefix}` with your configured `SUITECRM_PREFIX` (default: `suitecrm`).

Supported modules include: Accounts, Contacts, Leads, Opportunities, Cases, Calls, Meetings, Tasks, Notes, Emails, Documents, Campaigns, AOS_Quotes, AOS_Invoices, AOS_Products, AOS_Contracts, AOR_Reports, AOW_WorkFlow, SecurityGroups — and any custom modules in your instance.

---

## Prerequisites

- Ubuntu 20.04+ or Debian 11+ (the installers use `apt`, `systemd`, and `nginx`)
- Python 3.8+
- Root / sudo access
- Node.js is installed automatically if missing

---

## SuiteCRM API User Setup

Before connecting, make sure your CRM user has API access enabled:

1. Log into SuiteCRM as admin
2. Go to **Admin → User Management** → open the user you'll authenticate with
3. Check **"Is Admin"** OR set **"API User"** to Yes (the field name varies by SuiteCRM version)
4. Save

If API access isn't enabled, the gateway returns `CRM login failed: Invalid Login` with no further detail — this is the most common first-run failure.

For production: create a dedicated API user with only the module permissions your AI assistant needs. Don't use the admin account.

---

## Quick Start — Single CRM

For one CRM, no nginx. Connects directly to the port.

**Requirements:** Ubuntu/Debian, Python 3.8+, root access

```bash
git clone https://github.com/anirudhx7/suitecrm-mcp.git
cd suitecrm-mcp
sudo python3 install-single.py \
  --endpoint https://your-crm.example.com/service/v4_1/rest.php \
  --port 3101 \
  --prefix suitecrm \
  --label "My CRM"
```

After install, the gateway runs at `http://YOUR_SERVER:3101/sse`.

**Open the port** (if using ufw):
```bash
sudo ufw allow 3101/tcp
```

**Test credentials before connecting:**
```bash
curl -s -H "X-CRM-User: admin" -H "X-CRM-Pass: yourpassword" \
  http://YOUR_SERVER:3101/test
# Expected: {"success":true,"crm_user":"admin","prefix":"suitecrm"}
```

**Verify it's working in Claude Desktop:**

After adding the MCP server config (see [Connecting to Claude Desktop](#connecting-to-claude-desktop)) and restarting Claude Desktop, click the hammer icon in the bottom-left of the chat window. You should see 13 tools listed: `suitecrm_search`, `suitecrm_get`, etc.

Try a test prompt: `"List the first 5 accounts in the CRM"` — Claude should call `suitecrm_search` automatically.

---

## Multi-Entity Install

For N CRM instances behind nginx — each gets its own port and path.

**1. Copy and fill in the config:**
```bash
cp entities.example.json entities.json
# Edit entities.json with your CRM endpoints and ports
```

**2. Run the installer:**
```bash
sudo python3 install-multi.py --config entities.json
```

**3. Open the nginx port** (if using ufw):
```bash
sudo ufw allow 8080/tcp
```

**4. Test a specific entity:**
```bash
curl -s -H "X-CRM-User: admin" -H "X-CRM-Pass: yourpassword" \
  http://YOUR_SERVER:8080/crm1/test
# Expected: {"success":true,"crm_user":"admin","prefix":"suitecrm_crm1"}
```

**5. Connect at:** `http://YOUR_SERVER:8080/<code>/sse`

**Verify it's working in Claude Desktop:** After restarting Claude Desktop, click the hammer icon. You should see 13 tools per entity: `suitecrm_crm1_search`, `suitecrm_crm2_search`, etc.

**Add entities later (no downtime on existing):**
```bash
sudo python3 install-multi.py --add --config entities.json
```

**Remove an entity:**
```bash
sudo python3 install-multi.py --remove crm2
```

---

## Configuration

### Single entity — environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUITECRM_ENDPOINT` | Yes | — | Full URL to `/service/v4_1/rest.php` |
| `SUITECRM_PREFIX` | No | `suitecrm` | Tool name prefix |
| `PORT` | No | `3101` | Listen port |
| `SUITECRM_CODE` | No | — | Entity code for multi-entity nginx routing |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | — | Set to `0` only for self-signed certs |
| `NODE_NO_WARNINGS` | No | — | Set to `1` to suppress Node warnings |

### Multi-entity — entities.json

```json
{
  "crm1": {
    "label": "My Company CRM",
    "endpoint": "https://crm.mycompany.com/service/v4_1/rest.php",
    "port": 3101
  },
  "crm2": {
    "label": "Client B CRM",
    "endpoint": "https://crm.clientb.com/service/v4_1/rest.php",
    "port": 3102,
    "tls_skip": true
  }
}
```

Keys become the entity code (nginx path prefix, tool prefix suffix, service name). Ports must be unique.

---

## TLS / Self-Signed Certificates

If your SuiteCRM uses a self-signed certificate, add `"tls_skip": true` to the entity config (multi) or pass `--tls-skip` (single). This sets `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Only use this on trusted internal networks. Never expose a TLS-skipping gateway to the public internet.

---

## Compatible MCP Clients

Any MCP client that supports SSE transport with custom request headers will work. Tested with:

| Client | Works |
|--------|-------|
| Claude Desktop | Yes |
| Claude Code (CLI) | Yes |
| OpenClaw | Yes |

---

## Connecting to Claude Desktop

Add to `~/Library/Application\ Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "suitecrm": {
      "type": "sse",
      "url": "http://YOUR_SERVER:3101/sse",
      "headers": {
        "X-CRM-User": "your_crm_username",
        "X-CRM-Pass": "your_crm_password"
      }
    }
  }
}
```

For multi-entity, add one entry per CRM:
```json
{
  "mcpServers": {
    "suitecrm-crm1": {
      "type": "sse",
      "url": "http://YOUR_SERVER:8080/crm1/sse",
      "headers": {
        "X-CRM-User": "admin",
        "X-CRM-Pass": "password"
      }
    },
    "suitecrm-crm2": {
      "type": "sse",
      "url": "http://YOUR_SERVER:8080/crm2/sse",
      "headers": {
        "X-CRM-User": "admin",
        "X-CRM-Pass": "password"
      }
    }
  }
}
```

## Connecting to Claude Code

```bash
# Single entity
claude mcp add suitecrm --transport sse \
  --header "X-CRM-User:admin" \
  --header "X-CRM-Pass:yourpassword" \
  http://YOUR_SERVER:3101/sse

# Multi-entity
claude mcp add suitecrm-crm1 --transport sse \
  --header "X-CRM-User:admin" \
  --header "X-CRM-Pass:yourpassword" \
  http://YOUR_SERVER:8080/crm1/sse
```

## Connecting to OpenClaw

Add to your OpenClaw MCP server config:

```json
{
  "mcpServers": {
    "suitecrm": {
      "type": "sse",
      "url": "http://YOUR_SERVER:3101/sse",
      "headers": {
        "X-CRM-User": "your_crm_username",
        "X-CRM-Pass": "your_crm_password"
      }
    }
  }
}
```

For multi-entity, add one entry per CRM using the nginx URL pattern (`http://YOUR_SERVER:8080/<code>/sse`).

---

## Troubleshooting

**Check service status:**
```bash
sudo python3 install-single.py --status
# or
sudo python3 install-multi.py --status
```

**View logs:**
```bash
journalctl -u suitecrm-mcp -f          # single
journalctl -u suitecrm-mcp-crm1 -f     # multi
```

**Test auth without MCP:**
```bash
curl -H "X-CRM-User: admin" -H "X-CRM-Pass: password" \
  http://YOUR_SERVER:3101/test
```

**Common issues:**
- `CRM login failed` — wrong credentials, or the CRM user doesn't have API access enabled in SuiteCRM
- `Non-JSON response` — wrong endpoint URL, or the CRM is returning an error page; check the URL ends in `/service/v4_1/rest.php`
- `ECONNREFUSED` — the service isn't running; check `journalctl -u suitecrm-mcp`
- SSE connection drops — normal for long idle periods; clients reconnect automatically

---

## Supported SuiteCRM Versions

Tested on **SuiteCRM 8.8.x**. Should work on any SuiteCRM version that exposes the v4_1 REST API — this has been present since early SuiteCRM releases.

Does not support SugarCRM — the APIs diverged significantly after the SuiteCRM fork.

**Finding your endpoint URL**

The path to the REST API varies depending on how SuiteCRM was installed. Common patterns:

```
https://crm.example.com/service/v4_1/rest.php
https://crm.example.com/legacy/service/v4_1/rest.php
https://crm.example.com/crm/service/v4_1/rest.php
https://crm.example.com/crm/public/legacy/service/v4_1/rest.php
```

To find yours: log into SuiteCRM, go to **Admin → Diagnostic Tool** and look at the site URL, or check with whoever manages your server. The endpoint always ends in `/service/v4_1/rest.php` — only the prefix before it varies. Test it with:

```bash
curl -s -X POST "https://YOUR-PATH/service/v4_1/rest.php" \
  --data 'method=get_server_info&input_type=JSON&response_type=JSON&rest_data={}}'
# Should return: {"flavor":"CE","version":"...","gmt_time":"..."}
```

---

## Known Limitations

**LDAP / SSO users cannot authenticate via the REST API**

SuiteCRM's v4_1 REST API only authenticates against local database passwords. If your organisation uses LDAP, Active Directory, or SSO, users who log into the CRM web UI via those providers will not have a local password set — and the gateway will return `CRM login failed: Invalid Login` for them even with correct credentials.

**Workaround:** Create a dedicated local API user directly in the SuiteCRM database (not via LDAP). This user exists only for API access and is not tied to your SSO provider.

This is a SuiteCRM REST API limitation, not specific to this gateway.

---

## Security Notes

- Credentials travel as HTTP headers — use HTTPS in production (put the gateway behind a reverse proxy with a valid cert)
- Env files are written with mode `600` and the env directory with `700`
- `entities.json` is in `.gitignore` — never commit it

---

## License

<a href="https://github.com/Anirudhx7/suitecrm-mcp/blob/55c7985e1d67dd2fd49f6c793608d2380c107a7e/LICENSE">MIT</a> 
