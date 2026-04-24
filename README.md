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

```mermaid
flowchart TB
    IdP["🔐 Auth0 / Azure AD\nIdentity Provider"]

    subgraph Clients["MCP Clients"]
        CD["Claude Desktop"] ~~~ CC["Claude Code"] ~~~ OC["OpenClaw"]
    end

    GW["⚡ suitecrm-mcp gateway\nOAuth2 · API keys · SSE"]

    subgraph CRMs["SuiteCRM Instances"]
        C1[("CRM A")] ~~~ C2[("CRM B")] ~~~ CX[("CRM X")]
    end

    IdP -.->|"issues API key on login"| GW
    Clients -->|"Bearer token"| GW
    GW -->|"v4_1 REST API"| CRMs

    style GW fill:#2b6cb0,stroke:#63b3ed,stroke-width:2px,color:#fff
    style IdP fill:#2d3748,stroke:#718096,color:#e2e8f0
    style CD fill:#2a4a7f,stroke:#63b3ed,stroke-width:1px,color:#ebf8ff
    style CC fill:#2a4a7f,stroke:#63b3ed,stroke-width:1px,color:#ebf8ff
    style OC fill:#2a4a7f,stroke:#63b3ed,stroke-width:1px,color:#ebf8ff
    style C1 fill:#553c9a,stroke:#b794f4,stroke-width:1px,color:#faf5ff
    style C2 fill:#553c9a,stroke:#b794f4,stroke-width:1px,color:#faf5ff
    style CX fill:#553c9a,stroke:#b794f4,stroke-width:1px,color:#faf5ff
    style Clients fill:#0d1b2e,stroke:#4299e1,stroke-width:1px,color:#90cdf4
    style CRMs fill:#1a0533,stroke:#9f7aea,stroke-width:1px,color:#d6bcfa
```

Users log in once via Auth0 or Azure AD; the gateway issues a personal API key. MCP clients attach it as `Authorization: Bearer <key>` on every request. CRM credentials never leave the gateway. Multiple CRM instances are supported - each gets its own port and tool namespace (`suitecrm_crm1_*`, `suitecrm_crm2_*`).

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

For production, pin to a release tag such as `v4.0.1` instead of floating on `latest`.

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/anirudhx7/suitecrm-mcp/v4.0.1/docker-compose.yml
```

Edit `docker-compose.yml` and fill in `SUITECRM_ENDPOINT`, `AUTH0_*` vars, and `GATEWAY_PUBLIC_URL`, then:

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

  suitecrm-mcp-auth:
    image: ghcr.io/anirudhx7/suitecrm-mcp:v4.0.1
    command: node auth.mjs
    working_dir: /app
    ports:
      - "127.0.0.1:3100:3100"
    environment:
      AUTH0_DOMAIN: your-tenant.auth0.com
      AUTH0_CLIENT_ID: your-client-id
      AUTH0_CLIENT_SECRET: your-client-secret
      AUTH0_AUDIENCE: https://your-api-identifier
      GATEWAY_PUBLIC_URL: https://mcp.yourdomain.com
      SESSION_TTL_DAYS: "30"
      PORT: "3100"
    restart: unless-stopped

  suitecrm-mcp-crm1:
    image: ghcr.io/anirudhx7/suitecrm-mcp:v4.0.1
    ports:
      - "127.0.0.1:3101:3101"   # expose via reverse proxy only
    environment:
      SUITECRM_ENDPOINT: https://crm1.example.com/service/v4_1/rest.php
      SUITECRM_PREFIX: suitecrm_crm1
      SUITECRM_CODE: crm1
      AUTH0_DOMAIN: your-tenant.auth0.com
      AUTH0_AUDIENCE: https://your-api-identifier
      REQUIRED_GROUP: crm1_users
      PORT: "3101"
    depends_on:
      suitecrm-mcp-auth:
        condition: service_healthy
    restart: unless-stopped

  suitecrm-mcp-crm2:
    image: ghcr.io/anirudhx7/suitecrm-mcp:v4.0.1
    ports:
      - "127.0.0.1:3102:3102"   # expose via reverse proxy only
    environment:
      SUITECRM_ENDPOINT: https://crm2.example.com/legacy/service/v4_1/rest.php
      SUITECRM_PREFIX: suitecrm_crm2
      SUITECRM_CODE: crm2
      AUTH0_DOMAIN: your-tenant.auth0.com
      AUTH0_AUDIENCE: https://your-api-identifier
      REQUIRED_GROUP: crm2_users
      PORT: "3102"
    depends_on:
      suitecrm-mcp-auth:
        condition: service_healthy
    restart: unless-stopped
```

What changes per entity:
- Service name (`suitecrm-mcp-crm1`, `suitecrm-mcp-crm2`, ...)
- `SUITECRM_ENDPOINT` - the REST API URL for that specific CRM (the path after the domain varies by SuiteCRM installation)
- `SUITECRM_CODE` - short identifier used in tool names and URL routing (e.g. `crm1` gives tools named `suitecrm_crm1_search`, `suitecrm_crm1_get`, etc.)
- `PORT` and the host port mapping - each entity needs its own port (3101, 3102, ...)

What stays the same across all entities:
- `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` - one Auth0 app handles all entities
- The auth service (`suitecrm-mcp-auth`) is shared; entity containers depend on it

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
After authenticating at `/auth/login` and getting an API key:
```bash
curl -s -H "Authorization: Bearer smcp_your_api_key_here" \
  http://YOUR_SERVER:8080/crm1/test
# Expected: {"success":true,"crm_user":"...","email":"...","entity":"crm1"}
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
| `BIND_HOST` | No | `127.0.0.1` | Interface to bind the gateway server to |
| `SUITECRM_CODE` | No | - | Entity code for multi-entity nginx routing |
| `AUTH0_DOMAIN` | Yes (auth) | - | Auth0 tenant domain (entity gateway) |
| `AUTH0_AUDIENCE` | Yes (auth) | - | Auth0 API identifier (entity gateway) |
| `AUTH0_CLIENT_ID` | Yes (auth svc) | - | Auth0 client ID (auth service only) |
| `AUTH0_CLIENT_SECRET` | Yes (auth svc) | - | Auth0 client secret (auth service only) |
| `GATEWAY_PUBLIC_URL` | Yes (auth svc) | - | Public base URL of the gateway (auth service only) |
| `SESSION_TTL_DAYS` | No (auth svc) | `30` | Session token lifetime in days (auth service only) |
| `REQUIRED_GROUP` | No | - | Auth0 role required to access this entity |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | - | Set to `0` only for self-signed certs |
| `NODE_NO_WARNINGS` | No | - | Set to `1` to suppress Node warnings |
| `TRUST_PROXY` | No | - | Set to `1` when running behind nginx or another reverse proxy |
| `METRICS_PORT` | No | `9090` | Prometheus metrics server port |
| `METRICS_BIND` | No | `127.0.0.1` | Metrics server bind address |
| `CRM_TIMEOUT_MS` | No | `30000` | CRM REST API request timeout in ms |
| `CIRCUIT_BREAKER_THRESHOLD` | No | `5` | Consecutive CRM failures before circuit opens |
| `CIRCUIT_BREAKER_RESET_MS` | No | `60000` | Time in ms before circuit moves to half-open |

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

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | None | Shallow - always responds if the process is running |
| `GET /health/deep` | None | Deep - pings the CRM REST API and returns latency |

```bash
# Shallow health
curl http://YOUR_SERVER:3101/health
# {"status":"ok","entity":"crm1","port":3101,"active":2,"circuit_breaker":"closed"}

# Deep health (pings CRM, returns latency)
curl http://YOUR_SERVER:3101/health/deep
# {"status":"healthy","entity":"crm1","uptime":3600,"connections":2,"circuit_breaker":"closed",
#  "checks":{"endpoint":{"status":"ok","url":"https://crm.example.com"},
#             "api":{"status":"ok","latency_ms":45},
#             "sessions":{"status":"ok","active":2}},"duration_ms":47}
```

`/health/deep` returns HTTP 200 when healthy, 503 when the CRM is unreachable. Rate-limited to 10 requests/minute.

### Prometheus metrics

The gateway exposes a Prometheus metrics endpoint on a separate port (default 9090, localhost only). Metrics are per-entity and include:

| Metric | Type | Description |
|--------|------|-------------|
| `suitecrm_mcp_active_connections` | Gauge | Currently open SSE connections |
| `suitecrm_mcp_connections_total` | Counter | Total SSE connections established |
| `suitecrm_mcp_tool_calls_total` | Counter | Tool calls by name and status (success/error) |
| `suitecrm_mcp_tool_duration_seconds` | Histogram | Tool call latency (p50/p95/p99 via buckets) |
| `suitecrm_mcp_crm_api_duration_seconds` | Histogram | CRM REST API call latency |
| `suitecrm_mcp_session_renewals_total` | Counter | CRM session re-authentications |
| `suitecrm_mcp_auth_failures_total` | Counter | Authentication failures |
| `suitecrm_mcp_circuit_breaker_state` | Gauge | 0=closed, 1=half-open, 2=open |
| `suitecrm_mcp_circuit_breaker_openings_total` | Counter | Circuit breaker trip events |

```bash
# Scrape metrics (systemd)
curl http://127.0.0.1:9090/metrics

# Scrape metrics (Docker - use container name or host.docker.internal)
curl http://127.0.0.1:9090/metrics
```

The included `docker-compose.yml` starts a Prometheus + Grafana stack that scrapes the gateway automatically. Set `GRAFANA_PASSWORD` in your environment and visit `http://localhost:3000`.

For systemd installs, add a scrape target to `monitoring/prometheus.yml`:
```yaml
scrape_configs:
  - job_name: suitecrm-mcp
    static_configs:
      - targets: ['127.0.0.1:9090']
```

### Circuit breaker

The gateway tracks consecutive CRM REST API failures per entity. When the failure count reaches `CIRCUIT_BREAKER_THRESHOLD` (default 5), the circuit opens and all tool calls immediately return an error without hitting the CRM. After `CIRCUIT_BREAKER_RESET_MS` (default 60 seconds), the circuit moves to half-open and allows one probe call through. A successful probe closes the circuit; a failed probe keeps it open.

This prevents a slow or unresponsive CRM from tying up connections and causing cascading timeouts in the MCP client.

The current state appears in both `/health` and `{prefix}_server_info` tool responses.

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
- **API keys are personal and revocable.** Each user gets their own key tied to their identity. Admins can revoke a key instantly with `mcp-admin revoke <sub>`. Compromised keys do not expose other users.
- **CRM passwords never leave the gateway.** Client machines (Claude Desktop, Claude Code, OpenClaw) hold only an opaque `smcp_...` API key. CRM credentials are stored in `/etc/suitecrm-mcp/sessions.json` (mode 600) on the gateway.
- **Keep `AUTH0_CLIENT_SECRET` secret.** It is stored in `/etc/suitecrm-mcp/auth.env` (mode 600) and only read by the auth service.
- **Query sanitisation.** The `search` and `count` tools accept a SQL WHERE clause. The gateway blocks destructive SQL keywords (DROP, ALTER, DELETE, etc.) and comment/statement-chaining patterns. SuiteCRM's own API layer provides additional protection.
- Env files are written with mode `600` and the env directory with `700`
- `entities.json` and `user-profiles.json` are in `.gitignore` - never commit them

See [SECURITY.md](SECURITY.md) for full details on controls and known limitations.

---

## License

<a href="https://github.com/Anirudhx7/suitecrm-mcp/blob/55c7985e1d67dd2fd49f6c793608d2380c107a7e/LICENSE">MIT</a> 
