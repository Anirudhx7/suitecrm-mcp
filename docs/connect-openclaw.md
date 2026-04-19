# Connecting OpenClaw

OpenClaw uses a two-machine architecture: a remote gateway and a local bridge plugin.

```
[OpenClaw Machine]                    [Gateway Machine]
  OpenClaw runtime
    suitecrm-{code} plugin  --SSE-->  suitecrm-mcp gateway  -->  SuiteCRM REST API
    ~/.suitecrm-mcp/
      gateway.token  (API key, auto-saved after login)
```

The bridge is a Node.js plugin that OpenClaw loads. It handles authentication
automatically: if no token is found, it prints the auth URL and polls the gateway
in the background. Once the user logs in via a browser, the token is saved and
the connection completes - no CLI needed on the OpenClaw machine.

## Prerequisites

- A dedicated Ubuntu VM or server for the gateway
- OpenClaw installed on the client machine (Node.js required)
- Access to the gateway auth URL in a browser

---

## Step 1 - Install the gateway (gateway machine)

**Single entity** (one CRM):

```bash
sudo python3 install.py --url https://crm.example.com --domain mcp.example.com --email you@example.com
```

**Multi entity** (multiple CRMs):

```bash
cp entities.example.json entities.json
# Edit entities.json: add your CRM codes, labels, ports, endpoints, and group names
sudo python3 install.py --config entities.json --domain mcp.example.com --email you@example.com
```

The installer will prompt for OAuth2/OIDC configuration (Auth0/Azure AD).
See [docs/auth0-setup.md](auth0-setup.md) for how to create the identity provider app.

Note the gateway URL - you will need it in Step 2:
- With domain: `https://mcp.example.com`

**HTTPS is strongly recommended.** The `--domain` flag enables automatic TLS via
Let's Encrypt. Without it, API keys travel unencrypted.

---

## Step 2 - Install the bridge (OpenClaw machine)

Copy `install-bridge.py` from the gateway machine to the OpenClaw machine, then run:

**Single entity:**

```bash
sudo python3 install-bridge.py \
  --gateway https://mcp.example.com \
  --code mycrm \
  --label "My CRM"
```

**Multi entity** (same `entities.json` format):

```bash
sudo python3 install-bridge.py \
  --gateway https://mcp.example.com \
  --entities entities.json
```

To install for specific users only (default is all users with `~/.openclaw/openclaw.json`):

```bash
sudo python3 install-bridge.py --gateway ... --entities entities.json alice bob
```

**Agent scoping (optional):**

```bash
# All agents in OpenClaw get access
sudo python3 install-bridge.py --gateway ... --code mycrm --attach all

# Only specific agents (comma-separated names or IDs)
sudo python3 install-bridge.py --gateway ... --code mycrm --attach "Sales Bot,Support Agent"
```

---

## Step 3 - Restart OpenClaw

```bash
sudo systemctl restart openclaw-USERNAME
```

---

## Step 4 - Authenticate (per user, on OpenClaw machine)

Each user authenticates once:

1. **OpenClaw starts** - the bridge plugin detects no token and prints to its log:
   ```
   [SuiteCRM mycrm] No token found.
   [SuiteCRM mycrm] Authenticate at: https://mcp.example.com/auth/login
   ```

2. **User opens the URL** in any browser and logs in with their corporate account

3. **Bridge picks up the token automatically** (polling every 3 seconds) and connects:
   ```
   [SuiteCRM mycrm] Token received.
   [SuiteCRM mycrm] Connected to gateway
   ```

4. **Token is saved** to `~/.suitecrm-mcp/gateway.token` - future OpenClaw restarts
   connect immediately without prompting

No CLI setup script, no manual credential entry. The browser login is the only
user action required.

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

## Re-authenticating

If the token expires (default 90 days) or is revoked by an admin:

1. The bridge logs: `[SuiteCRM mycrm] Token rejected (HTTP 401) -- clearing token, re-auth required`
2. It immediately restarts polling and prints the auth URL again
3. The user visits the URL and logs in - no restart needed

---

## Updating the bridge

To reinstall bridge plugins without wiping the saved token (e.g. after a gateway upgrade):

```bash
sudo python3 install-bridge.py --update \
  --gateway https://mcp.example.com \
  --entities entities.json
```

---

## Removing the bridge

```bash
sudo python3 install-bridge.py \
  --remove alice bob \
  --gateway https://mcp.example.com \
  --entities entities.json
```

This removes the OpenClaw plugins and the saved token for the listed users and
deregisters them from `openclaw.json`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Auth URL never appears in logs | Bridge plugin not loaded | Check `openclaw.json` plugins section; re-run installer |
| Auth polling times out after 15 min | User did not complete login | Re-visit the auth URL and log in |
| `Token rejected (HTTP 401)` in logs | Token expired or revoked | Bridge restarts auth automatically - user visits URL again |
| `HTTP 403 Forbidden` | User not in required group for entity | Admin checks group membership in identity provider |
| `Rate limited (HTTP 429)` in logs | Too many reconnects | Wait 15 min; backoff is automatic |
| `Gateway connect failed` | Wrong gateway URL or gateway down | Check `--gateway` URL; `systemctl status suitecrm-mcp-*` on gateway |
| `OpenClaw not installed for user` | No `~/.openclaw` directory | Install OpenClaw first |
| TLS error | Self-signed cert on CRM | Add `--tls-skip` during gateway install |
