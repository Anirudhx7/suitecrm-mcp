# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

To report a security vulnerability, open a GitHub issue with the `security` label.
For sensitive disclosures, use GitHub's private vulnerability reporting feature
(Security tab -> Report a vulnerability).

Please do not disclose security vulnerabilities publicly until they have been addressed.

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
