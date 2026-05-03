# Connecting Claude Desktop

Claude Desktop connects directly to the gateway via SSE using a gateway-issued API key.
No CRM credentials are stored on your machine.

## 🔐 How authentication works

1. Your admin installs the gateway and configures an identity provider (Auth0, Azure AD, etc.)
2. You visit the gateway URL in your browser and log in with your corporate account
3. The success page shows your personal API key - copy it
4. Paste the API key into the Claude Desktop config below

Your API key is tied to your identity. The gateway uses it to look up your CRM account
and connect on your behalf. Keys expire after 30 days (configurable by your admin).

## 📋 Prerequisites

- Gateway v3.0+ installed and running (see [README](../README.md))
- Claude Desktop installed
- Your API key from `https://YOUR_GATEWAY/auth/login`

## 🔑 Get your API key

1. Visit `https://YOUR_GATEWAY/auth/login` (or just `https://YOUR_GATEWAY` - it redirects)
2. Log in with your corporate account
3. On the success page, expand **Claude Desktop** and copy the config block shown

The success page shows the exact JSON block ready to paste - you do not need to
construct it manually.

## 📁 Config file location

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

## 🔌 Single entity

```json
{
  "mcpServers": {
    "suitecrm": {
      "type": "sse",
      "url": "https://mcp.yourcompany.com/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY_HERE"
      }
    }
  }
}
```

## 🌐 Multi entity

Add one entry per entity. Each entity gets its own `/{code}/sse` path:

```json
{
  "mcpServers": {
    "suitecrm_crm1": {
      "type": "sse",
      "url": "https://mcp.yourcompany.com/crm1/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY_HERE"
      }
    },
    "suitecrm_crm2": {
      "type": "sse",
      "url": "https://mcp.yourcompany.com/crm2/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY_HERE"
      }
    }
  }
}
```

The same API key works for all entities you have access to.

## ▶️ Apply changes

Fully quit and relaunch Claude Desktop (menu bar > Quit, then reopen).

## ✅ Verify

Click the hammer icon in the bottom-left of the chat window. You should see 24 tools:
`suitecrm_search`, `suitecrm_get`, etc. (or `suitecrm_crm1_search` for multi entity).

Test prompt: `"List the first 5 accounts in the CRM"` - Claude should call `suitecrm_search` automatically.

## 🔄 Rotating your API key

If your key is compromised or expired:

1. Visit `https://YOUR_GATEWAY/auth/login` again and log in - a new key is issued automatically
2. Update `Authorization` in the config file
3. Restart Claude Desktop

Your admin can also revoke a key immediately via `mcp-admin revoke <sub>`.

## 🔧 Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No hammer icon / tools missing | Config file path wrong or JSON syntax error | Validate JSON, check file path |
| `HTTP 401 Unauthorized` | API key invalid or expired | Re-authenticate at `/auth/login` and update the config |
| `HTTP 403 Forbidden` | You are not in the required group for this entity | Ask your admin to check your group membership |
| `Connection refused` | Gateway not running | Check with your admin: `systemctl status suitecrm-mcp` |
| `429 Too Many Requests` | Rate limit hit on /sse (20 req/15 min) | Wait 15 minutes |
