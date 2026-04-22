# Connecting Claude Code (CLI)

Claude Code connects directly to the gateway via SSE using a gateway-issued API key.
No CRM credentials are stored on your machine.

## How authentication works

1. Visit the gateway URL in your browser and log in with your corporate account
2. The success page shows your personal API key
3. Run the `claude mcp add` command shown on the success page - or paste the key into the command below

## Prerequisites

- Gateway v3.0+ installed and running (see [README](../README.md))
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- Your API key from `https://YOUR_GATEWAY/auth/login`

## Get your API key

1. Visit `https://YOUR_GATEWAY/auth/login` (or just `https://YOUR_GATEWAY` - it redirects)
2. Log in with your corporate account
3. On the success page, expand **Claude Code** and copy the ready-to-run command

The success page shows the exact command with your key already embedded.

## Single entity

```bash
claude mcp add suitecrm \
  --transport sse \
  --header "Authorization:Bearer smcp_YOUR_API_KEY_HERE" \
  https://mcp.yourcompany.com/sse
```

## Multi entity

Run once per entity. Each gets its own MCP server entry:

```bash
claude mcp add suitecrm_crm1 \
  --transport sse \
  --header "Authorization:Bearer smcp_YOUR_API_KEY_HERE" \
  https://mcp.yourcompany.com/crm1/sse

claude mcp add suitecrm_crm2 \
  --transport sse \
  --header "Authorization:Bearer smcp_YOUR_API_KEY_HERE" \
  https://mcp.yourcompany.com/crm2/sse
```

The same API key works for all entities you have access to.

## Verify

```bash
claude mcp list
```

Start a session and test:

```
claude
> List the first 5 accounts in the CRM
```

Claude should call `suitecrm_search` automatically.

## Manage entries

```bash
# List all MCP servers
claude mcp list

# Remove an entry
claude mcp remove suitecrm
```

## Rotating your API key

If your key is compromised or expired:

```bash
# Remove the old entry
claude mcp remove suitecrm

# Re-authenticate at the gateway, then re-add with the new key
claude mcp add suitecrm \
  --transport sse \
  --header "Authorization:Bearer smcp_YOUR_NEW_API_KEY" \
  https://mcp.yourcompany.com/sse
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `HTTP 401 Unauthorized` | API key invalid or expired | Re-authenticate at `/auth/login` and re-add the entry |
| `HTTP 403 Forbidden` | Not in the required group for this entity | Ask your admin to check your group membership |
| `Connection refused` | Gateway not running | `systemctl status suitecrm-mcp` on the gateway machine |
| `429 Too Many Requests` | Rate limit hit on /sse (20 req/15 min) | Wait 15 minutes |
| TLS error with self-signed cert | `NODE_TLS_REJECT_UNAUTHORIZED` not set | Add `--tls-skip` during gateway install |
