# Connecting Claude Code (CLI)

Claude Code connects directly to the gateway via SSE. No bridge needed.

## Prerequisites

- Gateway installed and running (see [Quick Start](../README.md#quick-start---single-crm))
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- A SuiteCRM user with API access enabled

## Single entity

```bash
claude mcp add suitecrm \
  --transport sse \
  --header "X-CRM-User:your_crm_username" \
  --header "X-CRM-Pass:your_crm_password" \
  http://YOUR_SERVER:3101/sse
```

With HTTPS (`--domain` was used during install):

```bash
claude mcp add suitecrm \
  --transport sse \
  --header "X-CRM-User:your_crm_username" \
  --header "X-CRM-Pass:your_crm_password" \
  https://mcp.yourserver.com/sse
```

## Multi entity

Run once per entity. Each gets its own MCP server entry:

```bash
claude mcp add suitecrm_crm1 \
  --transport sse \
  --header "X-CRM-User:your_crm_username" \
  --header "X-CRM-Pass:your_crm_password" \
  http://YOUR_SERVER:8080/crm1/sse

claude mcp add suitecrm_crm2 \
  --transport sse \
  --header "X-CRM-User:your_crm_username" \
  --header "X-CRM-Pass:your_crm_password" \
  http://YOUR_SERVER:8080/crm2/sse
```

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

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `CRM authentication failed` | Wrong credentials or API access not enabled | Enable API access in SuiteCRM Admin > User Management |
| `Connection refused` | Gateway not running | `systemctl status suitecrm-mcp` |
| `429 Too Many Requests` | Rate limit hit on /sse (20 req/15 min) | Wait 15 minutes |
| TLS error with self-signed cert | `NODE_TLS_REJECT_UNAUTHORIZED` not set | Add `--tls-skip` during gateway install |
