# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| 1.x     | No        |

## Reporting a Vulnerability

To report a security vulnerability, open a GitHub issue with the `security` label.
For sensitive disclosures, use GitHub's private vulnerability reporting feature
(Security tab -> Report a vulnerability).

Please do not disclose security vulnerabilities publicly until they have been addressed.

## Security Controls

### Gateway (server/index.mjs)

- **Fail-fast auth:** Bad credentials on `/sse` return HTTP 401 immediately before the SSE stream opens. No half-open sessions are created.
- **SQL keyword blocklist:** The `query` and `order_by` parameters in search tools are checked against a blocklist of destructive SQL keywords (DROP, ALTER, DELETE, etc.) and comment/chaining patterns.
- **Module and ID validation:** Module names are validated against an allowlist. Record IDs must match strict UUID format (8-4-4-4-12 hex).
- **Rate limiting:** `/sse`, `/test`, and `/messages` are rate-limited independently.
- **No CORS header:** `Access-Control-Allow-Origin` is not set. Browser same-origin policy blocks cross-origin requests by default, including `Origin: null` contexts.
- **Credentials never stored:** Each SSE connection supplies its own credentials per request. Nothing is written to disk or held in memory beyond the session lifetime.

### Installer (install.py)

- **Input validation:** `--domain`, `--email`, and `--remove` entity codes are validated with strict regexes before any command is executed.
- **No shell injection:** All privileged subprocess calls use list form (`subprocess.run([...])`) so arguments are never interpreted by a shell. The only exception is the NodeSource setup bootstrap (`curl | bash`), which is a shell pipeline by design and is explicitly commented as such.
- **Session IDs excluded from nginx logs:** The `/messages` endpoint has `access_log off` in the generated nginx config. Session IDs passed as query parameters are not written to access logs.
- **Env files protected:** Written with mode `600`; the env directory is `700`. Both are owned by the `suitecrm-mcp` service user so root access is not required at runtime.
- **Unprivileged service user:** Both installers create a `suitecrm-mcp` system user (no shell, no home directory) and set `User=`/`Group=` in the generated systemd unit. The gateway process does not run as root.
- **Systemd sandboxing:** Generated units include `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, and `ReadWritePaths` limited to `/etc/suitecrm-mcp` and `/opt/suitecrm-mcp`. This restricts what a compromised process can reach on the host.
- **Proxy trust is conditional:** `X-Forwarded-For` is only trusted for rate limiting when `TRUST_PROXY=1` is set in the env file. The installers set this only where nginx is actually in front: always for multi-entity, only when `--domain` is used for single-entity. Direct port access leaves the header untrusted so clients cannot spoof their IP to shard rate limits.

## Known Security Limitations

### MD5 password hashing

The SuiteCRM v4_1 REST API requires passwords to be transmitted as MD5 hashes.
MD5 is cryptographically broken. This is a protocol constraint, not a gateway bug.

**Mitigation:** Always run the gateway behind HTTPS (use `--domain` flag or place behind
a TLS-terminating proxy). The gateway warns at startup if the CRM endpoint is not HTTPS.

### LDAP / SSO users

SuiteCRM's v4_1 REST API only authenticates against local database passwords. LDAP and SSO
users have no local password and cannot authenticate via this gateway. A dedicated local API
user must be created in the database. See the Known Limitations section in README.md.

### NodeSource bootstrap

The Node.js installer uses `curl https://deb.nodesource.com/setup_lts.x | bash` to set up the NodeSource APT repository. This is a privileged shell pipeline fetched over HTTPS. If you require a fully auditable install, download and verify the script manually before running the installer.
