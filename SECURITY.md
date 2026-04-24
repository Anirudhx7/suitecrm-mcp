# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 4.x     | Yes       |
| 3.x     | No        |
| 2.x     | No        |
| 1.x     | No        |

## Reporting a Vulnerability

To report a security vulnerability, open a GitHub issue with the `security` label.
For sensitive disclosures, use GitHub's private vulnerability reporting feature
(Security tab -> Report a vulnerability).

Please do not disclose security vulnerabilities publicly until they have been addressed.

## Security Controls

### Authentication (v4.0+)

- **OAuth2 Authorization Code flow:** Users authenticate via Auth0 (or any OIDC provider).
  The gateway is the sole OAuth client - MCP clients and bridges only hold a gateway-issued
  session token, never CRM credentials.
- **Session-based API keys:** On successful login, the auth service writes a session record
  to `sessions.json` (mode 600). The session token is a `crypto.randomBytes(32)` hex string
  tied to the user's sub, email, and groups. It expires after a configurable number of days
  (default 30).
- **Group-based entity access:** A per-entity `REQUIRED_GROUP` value is checked against the
  groups in the session. Users not in the required group receive HTTP 403.
- **Nonce-bound bridge pickup:** OpenClaw bridges start a session via
  `POST /auth/bridge/start`, receive a nonce plus bridge secret, and poll
  `GET /auth/bridge/poll/:nonce`. The poll result is returned exactly once and
  bridge sessions expire after 15 minutes.
- **Session expiry:** Tokens expire after a configurable number of days (default 30). Expired
  tokens receive HTTP 401 and users must re-authenticate.
- **Admin revocation:** Sessions can be revoked instantly via `mcp-admin revoke`.

### Gateway (server/index.mjs)

- **Fail-fast auth:** Invalid or missing bearer tokens on `/sse` return HTTP 401 immediately
  before the SSE stream opens. No half-open sessions are created.
- **Rate limiting:** `/sse` and `/test` are limited to 20 requests per 15 minutes per IP.
  `/messages` is limited to 100 requests per minute. `/health/deep` is limited to 10 per minute.
  Limits use `express-rate-limit` with standard headers (`RateLimit-*`).
- **Circuit breaker:** The gateway tracks consecutive CRM REST API failures. After
  `CIRCUIT_BREAKER_THRESHOLD` (default 5) failures, the circuit opens and all tool calls
  immediately return an error without hitting the CRM. The circuit resets after
  `CIRCUIT_BREAKER_RESET_MS` (default 60 s). This prevents a slow CRM from tying up
  connections and causing cascading timeouts.
- **No CORS header:** `Access-Control-Allow-Origin` is not set. Browser same-origin policy
  blocks cross-origin requests by default.
- **CRM credentials stored only on gateway:** Per-user CRM usernames and passwords live in
  `/etc/suitecrm-mcp/user-profiles.json` (mode 600, owned by the service user). MCP clients
  hold only an opaque session token.

### Installer (install.py)

- **Input validation:** All user-supplied values (domain, email, entity codes, OAuth URLs) are
  validated with strict regexes before any command is executed.
- **No shell injection:** All privileged subprocess calls use list form (`subprocess.run([...])`)
  so arguments are never interpreted by a shell. The only exception is the NodeSource setup
  bootstrap (`curl | bash`), which is a shell pipeline by design and is explicitly documented.
- **Session IDs excluded from nginx logs:** The `/messages` endpoint has `access_log off` in
  the generated nginx config.
- **Env files protected:** Written with mode `600`; the env directory is `700`. Both are owned
  by the `suitecrm-mcp` service user so root access is not required at runtime.
- **Unprivileged service user:** The installer creates a `suitecrm-mcp` system user (no shell,
  no home directory). The gateway process does not run as root.
- **Systemd sandboxing:** Generated units include `NoNewPrivileges=yes`, `PrivateTmp=yes`,
  `ProtectSystem=strict`, `ProtectHome=yes`, and `ReadWritePaths` limited to
  `/etc/suitecrm-mcp` and `/opt/suitecrm-mcp`.
- **Proxy trust is conditional:** `TRUST_PROXY=1` is set only where nginx is in front.

## Known Security Limitations

### MD5 password hashing

The SuiteCRM v4_1 REST API requires passwords to be transmitted as MD5 hashes.
MD5 is cryptographically broken. This is a protocol constraint, not a gateway bug.

**Mitigation:** Always run the gateway behind HTTPS.

### LDAP / SSO users

SuiteCRM's v4_1 REST API only authenticates against local database passwords. LDAP and SSO
users have no local password and cannot authenticate via REST directly.

**Mitigation:** Use `tools/crm-provision-user.sh` to set a local API password for LDAP/SSO
users. The gateway can run this automatically via SSH on first OAuth login if configured.
See the Known Limitations section in README.md.

### AUTH0_CLIENT_SECRET must be kept secret

`AUTH0_CLIENT_SECRET` grants the gateway the ability to exchange authorization codes for
tokens. Store it only in `/etc/suitecrm-mcp/auth.env` (mode 600). Do not include it in
Docker images, version control, or log output.

### NodeSource bootstrap

The Node.js installer uses `curl https://deb.nodesource.com/setup_lts.x | bash` to set up
the NodeSource APT repository. This is a privileged shell pipeline fetched over HTTPS. If
you require a fully auditable install, download and verify the script manually.
