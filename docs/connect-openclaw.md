# Connecting OpenClaw

OpenClaw uses a two-machine architecture: a remote gateway and a local bridge.

```
[OpenClaw Machine]                    [Gateway Machine]
  OpenClaw runtime
    suitecrm-{code} plugin  --SSE-->  suitecrm-mcp gateway
    reads ~/.suitecrm-mcp/                 talks to SuiteCRM REST API
```

The bridge is a Node.js plugin that OpenClaw loads. It connects to the remote
gateway on first tool use and proxies all 13 SuiteCRM tools through.

## Prerequisites

- A dedicated Ubuntu VM or server for the gateway (can be the same machine as SuiteCRM)
- OpenClaw installed on the client machine (Node.js required)
- A SuiteCRM user with API access enabled

---

## Step 1 - Install the gateway (gateway machine)

**Single entity** (one CRM, direct port access):

```bash
sudo python3 install-single.py \
  --endpoint https://crm.example.com/service/v4_1/rest.php \
  --port 3101
```

**Multi entity** (multiple CRMs, nginx routing):

```bash
# 1. Create entities.json
cp entities.example.json entities.json
# Edit entities.json with your CRM codes, labels, ports, and endpoints

# 2. Install
sudo python3 install-multi.py --config entities.json
```

Add `--domain mcp.yourserver.com --email you@example.com` to either installer
to enable automatic HTTPS via Let's Encrypt.

Note the gateway URL — you will need it in Step 2:
- Single: `http://YOUR_GATEWAY_IP:3101`
- Multi: `http://YOUR_GATEWAY_IP:8080`
- With HTTPS: `https://mcp.yourserver.com`

**The gateway URL must be a bare origin — no path component.** The bridge constructs
its own paths (`/sse`, `/{code}/sse`, `/test`). If your gateway is behind a
subdirectory proxy (e.g. `https://myserver.com/suitecrm-mcp/`), that setup is not
supported — the gateway must be at the root of the host or a dedicated subdomain.

---

## Step 2 - Install the bridge (OpenClaw machine)

**Single entity:**

```bash
sudo python3 install-bridge.py \
  --gateway http://YOUR_GATEWAY_IP:3101 \
  --code mycrm \
  --label "My CRM"
```

**Multi entity** (uses the same entities.json format):

```bash
sudo python3 install-bridge.py \
  --gateway http://YOUR_GATEWAY_IP:8080 \
  --entities entities.json
```

To install for specific users only (default is all users in /home):

```bash
sudo python3 install-bridge.py --gateway ... --entities entities.json alice bob
```

**Agent scoping (optional):**

By default the bridge registers the plugin but does not restrict which agents can call SuiteCRM tools. Use `--attach` to scope tool access to specific agents:

```bash
# All agents in OpenClaw get access
sudo python3 install-bridge.py --gateway ... --code mycrm --attach all

# Only specific agents get access (comma-separated names or IDs)
sudo python3 install-bridge.py --gateway ... --code mycrm --attach "Sales Bot,Support Agent"
```

Without `--attach`, the plugin loads and credentials work - but agent-level `tools.allow` lists are not modified. If your OpenClaw agents already have restrictive `tools.allow` lists, use `--attach` to add the SuiteCRM tools to the right ones.

---

## Step 3 - Configure credentials (per user, on OpenClaw machine)

Run as the OpenClaw user (not root):

```bash
suitecrm-setup          # show status for all entities
suitecrm-setup mycrm    # configure credentials for entity "mycrm"
```

The setup script will:
1. Prompt for CRM username and password
2. Test the credentials against the gateway `/test` endpoint
3. Save to `~/.suitecrm-mcp/mycrm.json` (mode 600)

---

## Step 4 - Restart OpenClaw

```bash
sudo systemctl restart openclaw-USERNAME
```

---

## Verify

OpenClaw should now expose 13 tools per entity:
- `suitecrm_mycrm_search`
- `suitecrm_mycrm_get`
- `suitecrm_mycrm_create`
- ... and 10 more

Test prompt: `"List the first 5 accounts in the CRM"` - OpenClaw should call
`suitecrm_mycrm_search` automatically.

---

## Managing credentials

```bash
# Check status of all entities
suitecrm-setup

# Reconfigure credentials for one entity
suitecrm-setup mycrm

# Remove credentials for one entity
suitecrm-setup mycrm --remove
```

Credentials live in `~/.suitecrm-mcp/` and are never sent to the gateway
machine — authentication happens per-connection via HTTP headers.

---

## Updating the bridge

To reinstall bridge plugins without wiping credentials (e.g. after a gateway upgrade):

```bash
sudo python3 install-bridge.py --update \
  --gateway http://YOUR_GATEWAY_IP:8080 \
  --entities entities.json
```

---

## Removing the bridge

```bash
sudo python3 install-bridge.py \
  --remove alice bob \
  --gateway http://YOUR_GATEWAY_IP:8080 \
  --entities entities.json
```

This removes the OpenClaw plugins and credentials for the listed users and
deregisters them from `openclaw.json`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Tools not visible in OpenClaw | Credentials not configured | Run `suitecrm-setup <code>` |
| `Auth rejected (HTTP 401)` in logs | Wrong CRM credentials | Re-run `suitecrm-setup <code>` |
| `Rate limited (HTTP 429)` in logs | Too many reconnects | Wait 15 min; backoff is automatic |
| `Gateway connect failed` | Wrong gateway URL or gateway down | Check `--gateway` URL; `systemctl status suitecrm-mcp` on gateway |
| `OpenClaw not installed for user` | No `~/.openclaw` directory | Install OpenClaw first |
| TLS error | Self-signed cert on CRM | Add `--tls-skip` during gateway install |
