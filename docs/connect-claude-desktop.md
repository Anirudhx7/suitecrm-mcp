# Connecting Claude Desktop

Claude Desktop connects directly to the gateway via SSE. No bridge needed.

## Prerequisites

- Gateway installed and running (see [Quick Start](../README.md#quick-start---single-crm))
- Claude Desktop installed
- A SuiteCRM user with API access enabled

## Config file location

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

## Single entity

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

With HTTPS (`--domain` was used during install):

```json
{
  "mcpServers": {
    "suitecrm": {
      "type": "sse",
      "url": "https://mcp.yourserver.com/sse",
      "headers": {
        "X-CRM-User": "your_crm_username",
        "X-CRM-Pass": "your_crm_password"
      }
    }
  }
}
```

## Multi entity

Add one entry per entity. Each has its own `/{code}/sse` path:

```json
{
  "mcpServers": {
    "suitecrm_crm1": {
      "type": "sse",
      "url": "http://YOUR_SERVER:8080/crm1/sse",
      "headers": {
        "X-CRM-User": "your_crm_username",
        "X-CRM-Pass": "your_crm_password"
      }
    },
    "suitecrm_crm2": {
      "type": "sse",
      "url": "http://YOUR_SERVER:8080/crm2/sse",
      "headers": {
        "X-CRM-User": "your_crm_username",
        "X-CRM-Pass": "your_crm_password"
      }
    }
  }
}
```

## Credential Security

- **Use HTTPS.** Credentials travel as HTTP headers. Without HTTPS they are visible on the network. Use the `--domain` flag during install, or put the gateway behind a TLS-terminating proxy.
- **Create a dedicated CRM API user.** Do not use your admin account. In SuiteCRM Admin - User Management, create a user (e.g. `claude-api`) and enable API access. Give it only the module permissions your AI assistant actually needs.
- **Treat this config file as a secret.** `claude_desktop_config.json` contains plaintext credentials. Do not check it into version control, do not back it up to unencrypted cloud storage, and restrict file permissions on shared machines.
- **Rotate credentials by editing this file.** If credentials are compromised, disable the CRM user in SuiteCRM Admin and create a new one. Update this file and restart Claude Desktop.

## Apply changes

Fully quit and relaunch Claude Desktop (menu bar > Quit, then reopen).

## Verify

Click the hammer icon in the bottom-left of the chat window. You should see 13 tools: `suitecrm_search`, `suitecrm_get`, etc. (or `suitecrm_crm1_search` for multi entity).

Test prompt: `"List the first 5 accounts in the CRM"` - Claude should call `suitecrm_search` automatically.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No hammer icon / tools missing | Config file path wrong or JSON syntax error | Validate JSON, check file path |
| `CRM authentication failed` | Wrong credentials or API access not enabled | Enable API access in SuiteCRM Admin > User Management |
| `Connection refused` | Gateway not running | `systemctl status suitecrm-mcp` on the gateway machine |
| `429 Too Many Requests` | Rate limit hit on /sse (20 req/15 min) | Wait 15 minutes |
| TLS error with self-signed cert | `NODE_TLS_REJECT_UNAUTHORIZED` not set | Add `--tls-skip` during gateway install |
