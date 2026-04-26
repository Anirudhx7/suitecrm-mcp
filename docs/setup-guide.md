# Complete Setup Guide

End-to-end guide for deploying suitecrm-mcp v3.1+ from scratch.

## Overview

```
[Identity Provider]          [Gateway VM]                        [CRM VMs]
  Auth0 / Azure AD  <------> suitecrm-mcp-auth (port 3100)
                               OAuth2 login, API key issuance
                               /etc/suitecrm-mcp/sessions.json

                             suitecrm-mcp-crm1 (port 3101)  ->  CRM A REST API
                               validates Bearer token          /service/v4_1/rest.php
                               proxies MCP tool calls

                             suitecrm-mcp-crm2 (port 3102)  ->  CRM B REST API
                               /etc/suitecrm-mcp/
                                 user-profiles.json
                                 entities.json

[User's machine]
  Claude Desktop / Claude Code / OpenClaw
    1. visits /auth/login  --->  auth service  --->  IdP login
    2. receives API key
    3. Bearer token on SSE  -->  entity gateway  -->  CRM
```

**What the gateway does:**
- Handles OAuth2 login (Authorization Code flow)
- Issues personal, revocable API keys to authenticated users
- Provisions CRM accounts via SSH on first login (if configured)
- Proxies MCP tool calls to the appropriate SuiteCRM instance

---

## Step 1 - Identity provider

Set up Auth0 or Azure AD before installing the gateway. The installer will prompt
for the credentials you collect here.

See [docs/auth0-setup.md](auth0-setup.md) for step-by-step instructions.

Minimum you need before continuing:
- OIDC issuer URL
- OAuth client ID and client secret
- Redirect URI registered: `https://YOUR_GATEWAY_DOMAIN/auth/callback`

---

## Step 2 - Prepare the gateway VM

Requirements:
- Ubuntu 20.04+ (or Debian 11+)
- Public IP or domain pointing to this VM
- Ports 80 and 443 open (for HTTPS + Let's Encrypt)
- SSH access from this VM to CRM VMs (if using SSH provisioning)

```bash
# Clone or download the repo
git clone https://github.com/Anirudhx7/suitecrm-mcp.git
cd suitecrm-mcp
```

---

## Step 3 - Configure entities

Copy and edit the entities config:

```bash
cp entities.example.json entities.json
```

Edit `entities.json`:

```json
{
  "crm1": {
    "label": "Main CRM",
    "endpoint": "https://crm.yourcompany.com/legacy/service/v4_1/rest.php",
    "port": 3101,
    "group": "CRM-Main"
  }
}
```

- `endpoint`: full REST API URL. If unsure, leave it as the base URL and the
  installer will auto-detect the correct path.
- `group`: the JWT claim value a user must have to access this entity. Must match
  a role/group you configured in your identity provider.
- `port`: each entity gets its own port (3101, 3102, ...). With nginx these are
  internal-only.

**Finding your REST API path:**

```bash
for path in /service/v4_1/rest.php /legacy/service/v4_1/rest.php /crm/service/v4_1/rest.php; do
  curl -sf -X POST "https://crm.example.com$path" \
    --data-urlencode 'method=get_server_info' \
    --data-urlencode 'input_type=JSON' \
    --data-urlencode 'response_type=JSON' \
    --data-urlencode 'rest_data={}' | python3 -m json.tool && echo "FOUND: $path" && break
done
```

---

## Step 4 - Install the gateway

```bash
sudo python3 install.py \
  --config entities.json \
  --domain mcp.yourcompany.com \
  --email you@yourcompany.com
```

The installer will:
1. Install Node.js, nginx, certbot
2. Prompt for OAuth2 configuration (issuer, client ID/secret, audience, gateway URL)
3. Generate a random `API_KEY_SECRET`
4. Write env files to `/etc/suitecrm-mcp/`
5. Create and start `suitecrm-mcp-*` systemd services
6. Configure nginx with entity routing and `/auth/` routing
7. Obtain a Let's Encrypt certificate

**Non-interactive install** (CI/automation):

```bash
sudo python3 install.py \
  --config entities.json \
  --domain mcp.yourcompany.com \
  --email you@yourcompany.com \
  --oauth-issuer https://your-tenant.auth0.com \
  --oauth-client-id YOUR_CLIENT_ID \
  --oauth-client-secret YOUR_CLIENT_SECRET \
  --oauth-audience https://your-tenant.auth0.com/api/v2/ \
  --gateway-url https://mcp.yourcompany.com
```

---

## Step 5 - Prepare CRM accounts (LDAP/SSO users only)

If your users authenticate via LDAP or SSO, they have no local SuiteCRM password.
The gateway needs a local password to call the REST API on their behalf.

Copy `tools/crm-provision-user.sh` to each CRM VM and run it as root:

```bash
# Single user
sudo crm-provision-user alice SecurePass123

# Bulk from CSV (username,password)
sudo crm-provision-user --csv users.csv
```

The script:
1. Auto-detects SuiteCRM's database from `config.php`
2. Sets the user's `user_hash` in the DB via PHP/PDO
3. Verifies API login works

For local SuiteCRM users, ensure **API access is enabled** in SuiteCRM Admin >
User Management > Edit User > Advanced tab > API Access = Yes.

---

## Step 6 - Configure SSH provisioning (optional)

If you want the gateway to automatically provision CRM accounts when users first
log in via OAuth, configure SSH access from the gateway VM to each CRM VM:

```bash
# On the gateway VM, generate a key if you don't have one
ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N ""

# Copy to each CRM VM
ssh-copy-id -i /root/.ssh/id_ed25519.pub root@crm1.internal
```

Then create `/etc/suitecrm-mcp/crm-hosts.json`:

```json
{
  "crm1": "crm1.internal",
  "crm2": "crm2.internal"
}
```

Then point the gateway at that host map from each entity's env file
(`/etc/suitecrm-mcp/crm1.env`):
```
CRM_HOSTS_FILE=/etc/suitecrm-mcp/crm-hosts.json
```

Per-entity SSH settings live in `crm-hosts.json`, for example:
```json
{
  "crm1": {
    "ssh_host": "crm1.internal",
    "ssh_user": "ubuntu",
    "ssh_key": "/etc/suitecrm-mcp/crm-ssh-key"
  }
}
```

Restart the service: `sudo systemctl restart suitecrm-mcp-crm1`

---

## Step 7 - Test the auth flow

```bash
# Check services are running
sudo python3 install.py --status

# Test gateway health
curl https://mcp.yourcompany.com/health

# Test auth redirect
curl -I https://mcp.yourcompany.com/
# Should return: 302 Location: /auth/login

# Test OIDC discovery (gateway startup probe)
curl https://YOUR_OAUTH_ISSUER/.well-known/openid-configuration
```

Then visit `https://mcp.yourcompany.com` in a browser and complete the login flow.
You should see the success page with your API key.

---

## Step 8 - Connect clients

- **Claude Desktop**: [docs/connect-claude-desktop.md](connect-claude-desktop.md)
- **Claude Code**: [docs/connect-claude-code.md](connect-claude-code.md)
- **OpenClaw**: [docs/connect-openclaw.md](connect-openclaw.md)

---

## Admin operations

### Periodic session cleanup

`sessions.json` accumulates expired entries over time. Run this periodically or add it as a cron job:

```bash
# Purge expired sessions (safe to run at any time)
python3 tools/mcp-admin sessions --purge-expired

# Example cron: run daily at 2am
echo "0 2 * * * suitecrm-mcp python3 /opt/suitecrm-mcp/tools/mcp-admin sessions --purge-expired" | sudo crontab -
```

---

### Check user profiles and API keys

```bash
# Requires python3, reads /etc/suitecrm-mcp/user-profiles.json
python3 tools/mcp-admin list
python3 tools/mcp-admin whoami --sub <sub>
python3 tools/mcp-admin revoke --sub <sub>
```

### Add a user who cannot authenticate via the normal OAuth flow

```bash
python3 tools/mcp-admin add --sub <sub> --entity <entity_code> --user <crm_username> --pass <crm_password>
```

### Update server code without reinstalling

```bash
git pull
sudo python3 install.py --update --config entities.json --skip-oauth
```

### Add a new entity

Edit `entities.json` to add the new entry, then:

```bash
sudo python3 install.py --add --config entities.json --skip-oauth
```

### Remove an entity

```bash
sudo python3 install.py --remove crm2
```

### Enable HTTPS on an existing plain HTTP install

```bash
sudo python3 install.py --config entities.json --domain mcp.yourcompany.com --email you@example.com --skip-oauth
```

---

## File layout after install

```
/opt/suitecrm-mcp/           gateway server code
  index.mjs
  auth.mjs
  package.json
  node_modules/

/etc/suitecrm-mcp/           config and runtime state (mode 700, owned by suitecrm-mcp)
  entities.json              entity list (written by installer)
  auth.env                   env vars for auth service (mode 600)
  crm1.env                   env vars for entity crm1 (mode 600)
  user-profiles.json         per-user API keys and CRM creds (mode 600, written at runtime)
  sessions.json              active gateway sessions (mode 600, written at runtime)
  crm-hosts.json             SSH host map for provisioning (if configured)
  domain                     saved domain for nginx rebuild

/etc/systemd/system/
  suitecrm-mcp-auth.service
  suitecrm-mcp-crm1.service
  suitecrm-mcp-crm2.service

/etc/nginx/sites-available/
  suitecrm-mcp               nginx config with entity and /auth/ routing
```
