# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x     | Yes       |
| 2.x     | No        |
| 1.x     | No        |

## Reporting a Vulnerability

To report a security vulnerability, open a GitHub issue with the `security` label.
For sensitive disclosures, use GitHub's private vulnerability reporting feature
(Security tab -> Report a vulnerability).

Please do not disclose security vulnerabilities publicly until they have been addressed.

## Security Controls

### Authentication (v3.0+)

- **OAuth2 Authorization Code flow:** Users authenticate via a configurable OIDC provider
  (Auth0, Azure AD, etc.). The gateway is the sole OAuth client - MCP clients and bridges
  only hold a gateway-issued API key, never CRM credentials.
- **OIDC discovery:** Provider endpoints (authorization, token, JWKS) are resolved via
  `/.well-known/openid-configuration` at startup. Supports any OIDC-compliant provider.
- **JWKS token validation:** ID tokens are validated against the provider's public keys
  using `jwks-rsa`. Keys are cached and auto-rotated.
- **CSRF protection:** The OAuth state parameter is generated with `crypto.randomBytes(32)`
  and validated on callback. Pending states are held in memory with a 10-minute TTL.
- **API key design:** Gateway-issued keys use the format `smcp_<64-hex><8-char HMAC>`.
  The HMAC binds each key to the `API_KEY_SECRET` so keys cannot be forged without the secret.
- **Group-based entity access:** A configurable JWT claim (e.g. `roles`, `groups`) is checked
  against a per-entity `REQUIRED_GROUP` value. Users not in the required group receive HTTP 403.
- **One-time token pickup:** The bridge polling endpoint (`/auth/status/:linux_user`) delivers
  the API key exactly once and deletes it. Tokens have a 15-minute TTL.
- **API key expiry:** Keys expire after a configurable number of days (default 90). Expired
  keys receive HTTP 401 and users must re-authenticate.
- **Admin revocation:** Keys can be revoked instantly via `mcp-profile-admin revoke` or the
  `POST /auth/revoke` endpoint (requires HMAC-signed admin header).

### Gateway (server/index.mjs)

- **Fail-fast auth:** Invalid or missing bearer tokens on `/sse` return HTTP 401 immediately
  before the SSE stream opens. No half-open sessions are created.
- **SQL keyword blocklist:** The `query` and `order_by` parameters in search tools are checked
  against a blocklist of destructive SQL keywords (DROP, ALTER, DELETE, etc.) and
  comment/chaining patterns.
- **Module and ID validation:** Module names are validated against an allowlist. Record IDs
  must match strict UUID format (8-4-4-4-12 hex).
- **Rate limiting:** `/sse`, `/auth/login`, `/auth/callback`, and `/messages` are rate-limited
  independently.
- **No CORS header:** `Access-Control-Allow-Origin` is not set. Browser same-origin policy
  blocks cross-origin requests by default, including `Origin: null` contexts.
- **CRM credentials stored only on gateway:** Per-user CRM usernames and passwords live in
  `/etc/suitecrm-mcp/user-profiles.json` (mode 600, owned by the service user). MCP clients
  hold only an opaque API key.
- **Circuit breaker:** Repeated CRM failures trip a per-entity circuit breaker that stops
  forwarding requests until the CRM recovers. Prevents cascading failures.

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

**Mitigation:** Always run the gateway behind HTTPS. The gateway warns at startup if the
CRM endpoint is not HTTPS.

### LDAP / SSO users

SuiteCRM's v4_1 REST API only authenticates against local database passwords. LDAP and SSO
users have no local password and cannot authenticate via REST directly.

**Mitigation:** Use `tools/crm-provision-user.sh` to set a local API password for LDAP/SSO
users. The gateway can run this automatically via SSH on first OAuth login if configured.
See the Known Limitations section in README.md.

### API_KEY_SECRET must be kept secret

If `API_KEY_SECRET` is compromised, an attacker can forge valid API keys for any user sub.
Keep it in `/etc/suitecrm-mcp/*.env` (mode 600). If it must be rotated, all existing API
keys become invalid and all users must re-authenticate.

### OAuth client secret

`OAUTH_CLIENT_SECRET` grants the gateway the ability to exchange authorization codes for
tokens. Store it only in the env file (mode 600). Do not include it in Docker images,
version control, or log output.

### NodeSource bootstrap

The Node.js installer uses `curl https://deb.nodesource.com/setup_lts.x | bash` to set up
the NodeSource APT repository. This is a privileged shell pipeline fetched over HTTPS. If
you require a fully auditable install, download and verify the script manually.
