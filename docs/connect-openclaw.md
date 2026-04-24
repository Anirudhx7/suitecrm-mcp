# Connecting OpenClaw

OpenClaw uses a two-machine architecture: a remote gateway and a local bridge plugin.

```
[OpenClaw Machine]                    [Gateway Machine]
  OpenClaw runtime
    suitecrm-{code} plugin  --SSE-->  suitecrm-mcp gateway  -->  SuiteCRM REST API
    ~/.suitecrm-mcp/
      gateway.token  (OAuth token, auto-saved after first tool call)
```

The bridge is a Node.js plugin that OpenClaw loads. It is silent at startup --
no auth prompt, no polling. Authentication is triggered lazily the first time a
SuiteCRM tool is actually called. The bridge requests a one-time login URL from
the gateway, returns it as the tool response (visible in Teams chat or wherever
the agent is running), and polls in the background. Once the user clicks the link
and logs in, the token is saved and all subsequent tool calls work silently.
No CLI needed on the OpenClaw machine.

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

## Step 4 - Authenticate (per user, triggered on first tool call)

Authentication is lazy -- nothing happens at startup. The first time a user asks
the agent to do something with SuiteCRM, the flow starts automatically:

1. **User invokes a SuiteCRM tool** (e.g. "List my open accounts") -- the bridge
   detects no token and calls `POST /auth/bridge/start` on the gateway.

2. **Gateway returns a one-time login URL** tied to a short-lived nonce. The bridge
   returns this URL as the tool response, so it appears directly in Teams chat
   (or wherever the agent is running):
   ```
   To connect to SuiteCRM, please authenticate:
   https://mcp.example.com/auth/login?bridge=abc123
   This link expires in 15 minutes.
   ```

3. **User clicks the link** and logs in with their corporate account (Microsoft,
   Auth0, or whatever identity provider is configured).

4. **Bridge polls in the background** (`GET /auth/bridge/poll/:nonce` every 3
   seconds). Once the gateway resolves the nonce session, the bridge receives
   the token and saves it:
   ```
   [SuiteCRM mycrm] Token received -- saving to ~/.suitecrm-mcp/gateway.token
   ```

5. **Subsequent tool calls work silently.** The token is stored per-Linux-user
   because the bridge runs as that user and writes only to its own home directory.
   The gateway never reads or writes user home directories.

6. **On expiry or revocation**, the bridge receives HTTP 401, clears the saved
   token, and sends a fresh login URL on the next tool call. No restart needed.

No CLI setup, no manual credential entry. The browser login is the only user
action required.

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

1. The next tool call returns HTTP 401 from the gateway.
2. The bridge clears `~/.suitecrm-mcp/gateway.token` and logs:
   `[SuiteCRM mycrm] Token rejected (HTTP 401) -- clearing token`
3. The bridge calls `POST /auth/bridge/start` and returns a fresh login URL
   as the tool response -- same flow as first-time auth.
4. The user clicks the link and logs in. No agent restart needed.

---

## Revoking a user's token (operators)

Two methods are available. Both require admin credentials on the gateway.

**Using mcp-admin (recommended):**

```bash
mcp-admin revoke <sub>
```

Where `<sub>` is the user's subject claim from the identity provider (typically
their user ID or email, depending on IdP configuration). This immediately
invalidates the token -- the next tool call from that user triggers a fresh
login prompt.

**Using the REST endpoint directly:**

```bash
curl -X POST https://mcp.example.com/auth/revoke \
  -H "X-Admin-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"sub": "user@example.com"}'
```

Returns `200 OK` on success. The bridge clears its local token on the next
tool call when it receives HTTP 401 from the gateway.

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
| Tool call returns a login URL instead of CRM data | Expected -- first-time auth or token expired | Click the URL and log in; next tool call works normally |
| Login URL never appears as tool response | Bridge plugin not loaded | Check `openclaw.json` plugins section; re-run installer |
| Login URL expired before user clicked it | Nonce TTL (15 min) elapsed | Call any SuiteCRM tool again -- a fresh URL is generated |
| Auth polling times out after 15 min | User did not complete login | Re-invoke any SuiteCRM tool to get a new login URL |
| `Token rejected (HTTP 401)` in logs | Token expired or revoked | Bridge clears token and sends fresh login URL on next tool call |
| `HTTP 403 Forbidden` | User not in required group for entity | Admin checks group membership in identity provider |
| `Rate limited (HTTP 429)` in logs | Too many reconnects | Wait 15 min; backoff is automatic |
| `Gateway connect failed` | Wrong gateway URL or gateway down | Check `--gateway` URL; `systemctl status suitecrm-mcp-*` on gateway |
| `OpenClaw not installed for user` | No `~/.openclaw` directory | Install OpenClaw first |
| TLS error | Self-signed cert on CRM | Add `--tls-skip` during gateway install |
