# Identity Provider Setup

The gateway supports any OIDC-compliant provider. This guide covers Auth0 and Azure AD,
the two most common configurations.

---

## 🔐 Auth0

### 1. Create a Regular Web Application

1. Log in to the [Auth0 Dashboard](https://manage.auth0.com)
2. Go to **Applications > Applications > Create Application**
3. Name it (e.g. `SuiteCRM MCP Gateway`)
4. Choose **Regular Web Application** - this is required for the Authorization Code flow
5. Click **Create**

### 2. Configure the application

On the **Settings** tab:

| Field | Value |
|-------|-------|
| Allowed Callback URLs | `https://YOUR_GATEWAY/auth/callback` |
| Allowed Logout URLs | `https://YOUR_GATEWAY` |
| Allowed Web Origins | `https://YOUR_GATEWAY` |

Under **Advanced Settings > Grant Types**, ensure these are checked:
- Authorization Code
- Refresh Token

Under **Advanced Settings > OAuth**, set:
- **JSON Web Token (JWT) Signature Algorithm**: RS256

Click **Save Changes**.

### 3. Note your credentials

From the Settings tab, copy:
- **Domain** (e.g. `your-tenant.auth0.com`) - this is your `OAUTH_ISSUER`
- **Client ID** - this is your `OAUTH_CLIENT_ID`
- **Client Secret** - this is your `OAUTH_CLIENT_SECRET`

For `OAUTH_AUDIENCE`, use the Auth0 Management API identifier
(`https://your-tenant.auth0.com/api/v2/`) or create a custom API in
Auth0 > APIs.

### 4. Configure group/role claims (required for entity access control)

The gateway reads group membership from the JWT to decide which CRM entities a user
can access. Auth0 does not include custom claims by default - add an Action:

1. Go to **Actions > Flows > Login**
2. Click **+** to add a custom action
3. Paste this code:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://suitecrm-mcp/';
  api.idToken.setCustomClaim(namespace + 'roles', event.authorization?.roles ?? []);
  api.accessToken.setCustomClaim(namespace + 'roles', event.authorization?.roles ?? []);
};
```

4. Deploy the action and add it to the Login flow

Then set `OAUTH_GROUPS_CLAIM=https://suitecrm-mcp/roles` in the gateway env file.

5. In Auth0 > **User Management > Roles**, create roles matching the `group` field
   in your `entities.json` (e.g. `CRM-MyCompany`). Assign users to roles.

### 5. Connect Azure AD (optional - for corporate SSO)

1. In Auth0, go to **Authentication > Enterprise > Microsoft Azure AD**
2. Create a new connection using your Azure AD tenant ID, client ID, and secret
3. Enable the connection on your SuiteCRM MCP Gateway application
4. Users will see "Log in with Microsoft" on the Auth0 login page

---

## 🏢 Azure AD (direct, without Auth0)

Use this if you want to skip Auth0 and authenticate directly against Azure AD.

### 1. Register an application

1. Go to [Azure Portal > App registrations > New registration](https://portal.azure.com)
2. Name: `SuiteCRM MCP Gateway`
3. Supported account types: **Accounts in this organizational directory only**
4. Redirect URI: Web - `https://YOUR_GATEWAY/auth/callback`
5. Click **Register**

### 2. Add a client secret

**Certificates & secrets > New client secret** - set an expiry and copy the value immediately.

### 3. Configure token claims

**Token configuration > Add optional claim > ID token**:
- Add: `email`, `preferred_username`

For groups: **Token configuration > Add groups claim**:
- Select **Security groups** (or **All groups**)
- Under each token type, choose **Group ID** (object ID) or
  **sAMAccountName** if synced from on-prem AD

Note: Azure AD sends group object IDs by default, not names. Set `REQUIRED_GROUP`
in the entity env to the group's object ID, or configure optional claims to emit
the `onpremisessecurityidentifier`.

### 4. Note your credentials

| Gateway env var | Azure AD value |
|----------------|----------------|
| `OAUTH_ISSUER` | `https://login.microsoftonline.com/YOUR_TENANT_ID/v2.0` |
| `OAUTH_CLIENT_ID` | Application (client) ID |
| `OAUTH_CLIENT_SECRET` | Client secret value |
| `OAUTH_AUDIENCE` | Application (client) ID (same as client ID) |
| `OAUTH_GROUPS_CLAIM` | `groups` |

---

## 📋 Installer prompts reference

When you run `sudo python3 install.py`, the OAuth section asks:

| Prompt | What to enter |
|--------|--------------|
| OIDC issuer URL | Auth0: `https://your-tenant.auth0.com` / Azure: `https://login.microsoftonline.com/TENANT_ID/v2.0` |
| OAuth client ID | From your app registration |
| OAuth client secret | From your app registration (keep this secret) |
| OAuth audience | Auth0: your API identifier / Azure AD: your client ID |
| Gateway external URL | `https://mcp.yourcompany.com` - must match what you registered as the callback origin |
| JWT groups claim | Auth0 with custom action: `https://suitecrm-mcp/roles` / Azure AD: `groups` / default: `roles` |

---

## ✅ Verifying the setup

After installation, visit `https://YOUR_GATEWAY/auth/login`. You should be redirected
to your identity provider's login page. After logging in successfully, you should see
the success page with your API key.

If you see an error, check:
- The callback URL registered in your identity provider matches exactly
- `OAUTH_ISSUER` has no trailing slash
- The `/.well-known/openid-configuration` endpoint is reachable from the gateway VM:
  `curl https://YOUR_ISSUER/.well-known/openid-configuration`
