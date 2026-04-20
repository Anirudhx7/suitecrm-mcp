# suitecrm-mcp

An open-source MCP (Model Context Protocol) gateway for SuiteCRM. Lets AI assistants - Claude, OpenAI, or any MCP-compatible client - read and write your CRM data over a persistent SSE connection.

Built from a real production deployment. CData's version is commercial. This one isn't.

## Features

- **13 tools** covering the full CRUD surface: search, get, create, update, delete, count, relationships, module introspection
- **SSE transport** - compatible with Claude Desktop, Claude Code, OpenClaw, and any MCP client that supports HTTP+SSE
- **OAuth2/OIDC authentication** - users log in via Auth0, Azure AD, or any OIDC provider; the gateway issues personal, revocable API keys
- **No credentials on client machines** - MCP clients hold only an opaque API key; CRM passwords live on the gateway
- **Group-based entity access** - JWT group claims gate which CRM instances each user can reach
- **Session auto-renewal** - CRM sessions re-authenticate transparently on expiry
- **Unified installer** - one script handles single CRM (no nginx) or N CRMs behind nginx, with interactive OAuth setup
- **Entity-prefixed tools** - run multiple CRM instances side-by-side without name collisions

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

Supported modules include: Accounts, Contacts, Leads, Opportunities, Cases, Calls, Meetings, Tasks, Notes, Emails, Documents, Campaigns, AOS_Quotes, AOS_Invoices, AOS_Products, AOS_Contracts, AOR_Reports, AOW_WorkFlow, SecurityGroups - and any custom modules in your instance.

---

## Architecture

**Multi-entity** (N CRMs behind nginx):

```mermaid
flowchart TB
    IdP["Identity Provider\nAuth0 / Azure AD"]

    subgraph Clients["MCP Clients"]
        CD["Claude Desktop"]
        CC["Claude Code"]
        OC["OpenClaw"]
    end

    Clients -->|"HTTPS :443\nAuthorization: Bearer smcp_..."| NX
    CD & CC -.->|"1. browser login"| IdP
    IdP -.->|"2. JWT → API key"| NX

    subgraph Server["Gateway Server"]
        NX["nginx :443\nTLS termination\nmulti-entity routing\n/auth/ routing"]

        NX -->|"/crm1/"| N1["Node.js :3101\ntools: suitecrm_crm1_*"]
        NX -->|"/crm2/"| N2["Node.js :3102\ntools: suitecrm_crm2_*"]
        NX -->|"/auth/"| N1
    end

    N1 -->|"v4_1 REST API"| S1[("SuiteCRM A")]
    N2 -->|"v4_1 REST API"| S2[("SuiteCRM B")]
```

**Single-entity** (direct port or with `--domain`):

```mermaid
flowchart LR
    IdP["Identity Provider"] -.->|"JWT → API key"| N
    MC["MCP Client\nClaude / OpenClaw"] -->|"SSE :443\nBearer token"| N["Node.js :3101\ntools: suitecrm_*"] -->|"v4_1 REST API"| CRM[("SuiteCRM")]
```

Each Node.js process is a standalone systemd service. Users authenticate once via their identity provider; the gateway stores per-user CRM credentials in `/etc/suitecrm-mcp/user-profiles.json` and uses them for all subsequent tool calls. CRM sessions auto-renew on expiry and are cleaned up on disconnect.

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

If API access isn't enabled, the gateway returns HTTP 401 with `CRM authentication failed: Invalid Login` immediately on connection - this is the most common first-run failure.

For production: create a dedicated API user with only the module permissions your AI assistant needs. Don't use the admin account.

---

## Docker

The fastest way to run the gateway without touching Node.js or system packages. A pre-built image is published to GitHub Container Registry on every push to `main`.

For production, pin to a release tag such as `v3.0.0` instead of floating on `latest`.

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/anirudhx7/suitecrm-mcp/v3.0.0/docker-compose.yml
```

Edit `docker-compose.yml` and fill in `SUITECRM_ENDPOINT`, all `OAUTH_*` vars, and `API_KEY_SECRET`, then:

```bash
docker compose up -d
```

The gateway runs at `http://localhost:3101`. Visit `/auth/login` to authenticate and get an API key.

To update to a newer pinned release, change the image tag in `docker-compose.yml` and redeploy:
```bash
docker compose pull && docker compose up -d
```

For self-signed CRM certificates, add `NODE_TLS_REJECT_UNAUTHORIZED: "0"` to the environment block. For HTTPS termination (required for OAuth in production), put a reverse proxy (nginx, Caddy) in front.

**Test gateway health:**
```bash
curl http://localhost:3101/health
```

### Multi-entity with Docker

Each container handles exactly one CRM entity. For N entities, add N service blocks to `docker-compose.yml`, each on its own port.

```yaml
services:

  suitecrm-mcp-crm1:
    image: ghcr.io/anirudhx7/suitecrm-mcp:v3.0.0
    ports:
      - "3101:3101"
    environment:
      SUITECRM_ENDPOINT: https://crm1.example.com/service/v4_1/rest.php
      SUITECRM_PREFIX: suitecrm
      SUITECRM_CODE: crm1         # entity code - sets tool names to suitecrm_crm1_*
      PORT: "3101"
      OAUTH_ISSUER: https://your-tenant.auth0.com
      OAUTH_CLIENT_ID: your-client-id
      OAUTH_CLIENT_SECRET: your-client-secret
      OAUTH_AUDIENCE: https://your-tenant.auth0.com/api/v2/
      OAUTH_REDIRECT_URI: https://mcp.yourcompany.com/auth/callback
      GATEWAY_EXTERNAL_URL: https://mcp.yourcompany.com
      API_KEY_SECRET: same-secret-for-all-entities
    restart: unless-stopped

  suitecrm-mcp-crm2:
    image: ghcr.io/anirudhx7/suitecrm-mcp:v3.0.0
    ports:
      - "3102:3102"
    environment:
      SUITECRM_ENDPOINT: https://crm2.example.com/legacy/service/v4_1/rest.php
      SUITECRM_PREFIX: suitecrm
      SUITECRM_CODE: crm2         # entity code - sets tool names to suitecrm_crm2_*
      PORT: "3102"
      OAUTH_ISSUER: https://your-tenant.auth0.com
      OAUTH_CLIENT_ID: your-client-id
      OAUTH_CLIENT_SECRET: your-client-secret
      OAUTH_AUDIENCE: https://your-tenant.auth0.com/api/v2/
      OAUTH_REDIRECT_URI: https://mcp.yourcompany.com/auth/callback
      GATEWAY_EXTERNAL_URL: https://mcp.yourcompany.com
      API_KEY_SECRET: same-secret-for-all-entities
    restart: unless-stopped
```

What changes per entity:
- Service name (`suitecrm-mcp-crm1`, `suitecrm-mcp-crm2`, ...)
- `SUITECRM_ENDPOINT` - the REST API URL for that specific CRM (the path after the domain varies by SuiteCRM installation)
- `SUITECRM_CODE` - short identifier used in tool names and URL routing (e.g. `crm1` gives tools named `suitecrm_crm1_search`, `suitecrm_crm1_get`, etc.)
- `PORT` and the host port mapping - each entity needs its own port (3101, 3102, ...)

What stays the same across all entities:
- `API_KEY_SECRET` - must be identical so that API keys issued by any entity are valid on all
- All `OAUTH_*` vars - one OAuth app handles all entities
- `GATEWAY_EXTERNAL_URL` and `OAUTH_REDIRECT_URI`

Put a reverse proxy (nginx, Caddy) in front to route `/crm1/` to port 3101, `/crm2/` to port 3102, and `/auth/` to any one instance. For production use with multiple CRMs, `install.py --config entities.json` handles all of this automatically on a Linux host.

---

## Quick Start - Single CRM

For one CRM with automatic HTTPS and OAuth login.

**Requirements:** Ubuntu/Debian, Python 3.8+, root access, a domain pointing to this server, OAuth app credentials (see [docs/auth0-setup.md](docs/auth0-setup.md))

```bash
git clone https://github.com/anirudhx7/suitecrm-mcp.git
cd suitecrm-mcp
sudo python3 install.py \
  --url https://your-crm.example.com \
  --domain mcp.yourserver.com \
  --email you@example.com
```

The installer will prompt for OAuth configuration (issuer, client ID/secret, audience, gateway URL), then set up nginx, certbot, and systemd automatically.

After install, users authenticate at `https://mcp.yourserver.com/auth/login` to get their API key.

**Test gateway health:**
```bash
curl https://mcp.yourserver.com/health
```

**Verify it's working in Claude Desktop:**

After adding the MCP server config (see [docs/connect-claude-desktop.md](docs/connect-claude-desktop.md)) and restarting Claude Desktop, click the hammer icon. You should see 13 tools: `suitecrm_search`, `suitecrm_get`, etc.

Try a test prompt: `"List the first 5 accounts in the CRM"` - Claude should call `suitecrm_search` automatically.

---

## Multi-Entity Install

For N CRM instances behind nginx - each gets its own port and path.

**1. Copy and fill in the config:**
```bash
cp entities.example.json entities.json
# Edit entities.json with your CRM endpoints and ports
```

**2. Run the installer:**
```bash
sudo python3 install.py --config entities.json
```

**3. Enable HTTPS (recommended for production):**

Pass `--domain` and `--email`. The installer updates the nginx config with your domain and runs certbot automatically.

```bash
sudo python3 install.py --config entities.json \
  --domain mcp.yourserver.com \
  --email you@example.com
```

The domain must already point to this server's public IP, and ports 80 and 443 must be open. After this step the gateway is available at `https://mcp.yourserver.com/<code>/sse`.

Once configured, the domain is saved automatically. Later `--add` and `--remove` runs preserve HTTPS without needing `--domain` again.

**4. Open the nginx port** (if using ufw, HTTP-only installs only):
```bash
sudo ufw allow 8080/tcp
```

**5. Test a specific entity:**
```bash
curl -s -H "X-CRM-User: admin" -H "X-CRM-Pass: yourpassword" \
  http://YOUR_SERVER:8080/crm1/test
# Expected: {"success":true,"crm_user":"admin","prefix":"suitecrm_crm1"}
```

**6. Connect at:** `http://YOUR_SERVER:8080/<code>/sse` (or `https://your-domain/<code>/sse` if HTTPS is enabled)

**Verify it's working in Claude Desktop:** After restarting Claude Desktop, click the hammer icon. You should see 13 tools per entity: `suitecrm_crm1_search`, `suitecrm_crm2_search`, etc.

**Add entities later (no downtime on existing):**
```bash
sudo python3 install.py --add --config entities.json
```

**Remove an entity:**
```bash
sudo python3 install.py --remove crm2
```

---

## Configuration

### Single entity - environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUITECRM_ENDPOINT` | Yes | - | Full URL to `/service/v4_1/rest.php` |
| `SUITECRM_PREFIX` | No | `suitecrm` | Tool name prefix |
| `PORT` | No | `3101` | Listen port |
| `METRICS_PORT` | No | `9090` | Prometheus metrics port (localhost only) |
| `SUITECRM_CODE` | No | - | Entity code for multi-entity nginx routing |
| `CRM_TIMEOUT_MS` | No | `30000` | CRM API request timeout in ms |
| `CIRCUIT_BREAKER_THRESHOLD` | No | `5` | Consecutive failures before circuit opens |
| `CIRCUIT_BREAKER_RESET_MS` | No | `60000` | ms before circuit tests recovery |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | - | Set to `0` only for self-signed certs |
| `NODE_NO_WARNINGS` | No | - | Set to `1` to suppress Node warnings |

### Multi-entity - entities.json

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

## Health Checks and Monitoring

### Health endpoints

| Endpoint | Use for | Response time |
|----------|---------|---------------|
| `GET /health` | Liveness probe, quick status | <1ms, no external calls |
| `GET /health/deep` | Readiness probe, CRM connectivity | 100-500ms, calls CRM API |

```bash
curl http://YOUR_SERVER:3101/health
# {"status":"ok","version":"2.0.0","prefix":"suitecrm","uptime":3600,"connections":2,"circuit_breaker":"closed"}

curl http://YOUR_SERVER:3101/health/deep
# {"status":"healthy","checks":{"endpoint":{"status":"ok"},"api":{"status":"ok","latency_ms":142},...}}
```

`/health/deep` returns HTTP 503 with `"status":"unhealthy"` if the CRM is unreachable, and 200 with `"status":"degraded"` if the endpoint is reachable but the API is not responding.

### Prometheus metrics

The gateway exposes 9 metrics on a separate server at `127.0.0.1:METRICS_PORT/metrics` (default port 9090). This port is never routed through nginx and is only reachable by a local Prometheus instance.

```bash
# systemd installs only - for Docker, query via Prometheus at localhost:9090
curl http://127.0.0.1:9090/metrics | grep suitecrm_mcp
```

### Grafana dashboard

The `monitoring/` directory contains a ready-to-use Prometheus + Grafana stack. To start it alongside the gateway:

```bash
# Set Grafana admin password (optional - defaults to "changeme")
echo "GRAFANA_PASSWORD=yourpassword" > .env

docker compose up -d
```

Grafana runs at `http://localhost:3000`. The pre-built dashboard includes panels for active connections, tool call rate, error rate, auth failures, tool latency percentiles (p50/p95/p99), CRM API latency by method, and circuit breaker state.

For systemd installs (non-Docker), install Prometheus separately and point it at `127.0.0.1:METRICS_PORT`. See `monitoring/prometheus.yml` for a multi-entity config example.

### Circuit breaker

The gateway has a built-in circuit breaker. After `CIRCUIT_BREAKER_THRESHOLD` consecutive CRM failures (default 5), it switches to OPEN state and fails fast instead of waiting for each timeout. After `CIRCUIT_BREAKER_RESET_MS` (default 60s) it allows one test request through to check recovery.

The current state is visible in `/health`, `/health/deep`, `{prefix}_server_info`, and the `suitecrm_mcp_circuit_breaker_state` metric.

---

## TLS

### Gateway HTTPS (Let's Encrypt)

Pass `--domain` and `--email` to the installer to enable HTTPS on the gateway itself. The installer sets up nginx as a TLS-terminating reverse proxy and runs certbot to obtain and auto-renew a certificate.

Requirements:
- Domain must already point to this server's public IP
- Ports 80 (ACME challenge) and 443 (HTTPS) must be open

If certbot fails during install, the gateway still runs over HTTP. Fix DNS/firewall and re-run:
```bash
certbot --nginx -d your.domain.com -m you@example.com --agree-tos --redirect
```

### Self-Signed CRM Certificates

If your SuiteCRM uses a self-signed certificate, add `"tls_skip": true` to the entity config (multi) or pass `--tls-skip` (single). This sets `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Only use this on trusted internal networks. Never expose a TLS-skipping gateway to the public internet.

---

## Connecting a Client

Any MCP client that supports SSE transport with custom request headers will work.
Each client has a different setup process - see the dedicated guide for your client:

| Client | How it connects | Setup guide |
|--------|----------------|-------------|
| Claude Desktop | SSE direct - no bridge needed | [docs/connect-claude-desktop.md](docs/connect-claude-desktop.md) |
| Claude Code (CLI) | SSE direct - no bridge needed | [docs/connect-claude-code.md](docs/connect-claude-code.md) |
| OpenClaw | Bridge installer required | [docs/connect-openclaw.md](docs/connect-openclaw.md) |

**Claude Desktop and Claude Code** connect directly to the gateway URL over SSE.
After installing the gateway, add the SSE endpoint and your CRM credentials to
your client config. Full steps including single/multi entity configs, HTTPS
variants, and verification are in the guides above.

**OpenClaw** uses a two-component setup: the gateway runs on a remote server
(installed via `install.py`) and a bridge plugin runs locally on the OpenClaw
machine (installed via `install-bridge.py`). The bridge proxies all 13 SuiteCRM
tools through to the gateway. The OpenClaw guide covers both components end to end.

---

## Troubleshooting

**Check service status:**
```bash
sudo python3 install.py --status
```

**View logs:**
```bash
journalctl -u suitecrm-mcp -f          # single
journalctl -u suitecrm-mcp-crm1 -f     # multi
```

**Test gateway health:**
```bash
curl https://mcp.yourserver.com/health
```

**Common issues:**
- `HTTP 401` on SSE - API key invalid or expired; re-authenticate at `/auth/login`
- `HTTP 403` on SSE - user not in the required group for this entity; check identity provider group membership
- OAuth callback error - verify `OAUTH_REDIRECT_URI` matches exactly what is registered in your identity provider
- `CRM login failed` after OAuth - CRM user not found or API access not enabled; check `user-profiles.json`
- `Non-JSON response` - wrong CRM endpoint URL; check it ends in `/service/v4_1/rest.php`
- `ECONNREFUSED` - service isn't running; `journalctl -u suitecrm-mcp`
- SSE connection drops - normal for long idle periods; clients reconnect automatically

---

## Supported SuiteCRM Versions

Tested on **SuiteCRM 8.8.x**. Should work on any SuiteCRM version that exposes the v4_1 REST API - this has been present since early SuiteCRM releases.

Does not support SugarCRM - the APIs diverged significantly after the SuiteCRM fork.

**Finding your endpoint URL**

The path to the REST API varies depending on how SuiteCRM was installed. Common patterns:

```
https://crm.example.com/service/v4_1/rest.php
https://crm.example.com/legacy/service/v4_1/rest.php
https://crm.example.com/crm/service/v4_1/rest.php
https://crm.example.com/crm/public/legacy/service/v4_1/rest.php
```

To find yours: log into SuiteCRM, go to **Admin → Diagnostic Tool** and look at the site URL, or check with whoever manages your server. The endpoint always ends in `/service/v4_1/rest.php` - only the prefix before it varies. Test it with:

```bash
curl -s -X POST "https://YOUR-PATH/service/v4_1/rest.php" \
  --data 'method=get_server_info&input_type=JSON&response_type=JSON&rest_data={}'
# Should return: {"flavor":"CE","version":"...","gmt_time":"..."}
```

---

## Known Limitations

**LDAP / SSO users cannot authenticate via the REST API**

SuiteCRM's v4_1 REST API only authenticates against local database passwords. If your organisation uses LDAP, Active Directory, or SSO, users who log into the CRM web UI via those providers will not have a local password set - and the gateway will return `CRM login failed: Invalid Login` for them even with correct credentials.

**Workaround:** Use [`tools/create-api-user.sh`](tools/create-api-user.sh) to set a local API password for any existing LDAP/SSO user without touching their web login. Supports single user (interactive) and bulk mode via CSV.

```bash
# Single user
bash tools/create-api-user.sh

# Bulk - CSV format: username,password
bash tools/create-api-user.sh --csv users.csv
```

This is a SuiteCRM REST API limitation, not specific to this gateway.

---

## Security Notes

- **HTTPS is required for production.** OAuth flows and API keys must not travel over plain HTTP. Use `--domain` to enable Let's Encrypt, or put the gateway behind a TLS-terminating proxy.
- **API keys are personal and revocable.** Each user gets their own key tied to their identity. Admins can revoke a key instantly with `python3 tools/mcp-profile-admin revoke <sub>`. Compromised keys do not expose other users.
- **CRM passwords never leave the gateway.** Client machines (Claude Desktop, Claude Code, OpenClaw) hold only an opaque `smcp_...` API key. CRM credentials are stored in `/etc/suitecrm-mcp/user-profiles.json` (mode 600) on the gateway.
- **Keep `API_KEY_SECRET` and `OAUTH_CLIENT_SECRET` secret.** These are stored in env files (mode 600). Rotating `API_KEY_SECRET` invalidates all issued API keys.
- **Query sanitisation.** The `search` and `count` tools accept a SQL WHERE clause. The gateway blocks destructive SQL keywords (DROP, ALTER, DELETE, etc.) and comment/statement-chaining patterns. SuiteCRM's own API layer provides additional protection.
- Env files are written with mode `600` and the env directory with `700`
- `entities.json` and `user-profiles.json` are in `.gitignore` - never commit them

See [SECURITY.md](SECURITY.md) for full details on controls and known limitations.

---

## License

<a href="https://github.com/Anirudhx7/suitecrm-mcp/blob/55c7985e1d67dd2fd49f6c793608d2380c107a7e/LICENSE">MIT</a> 
