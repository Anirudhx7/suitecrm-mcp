# User Offboarding Runbook

Use this checklist to fully offboard a user from the MCP gateway. Work through the steps in order.

---

## Checklist

### 1. Revoke active gateway sessions

Forces the user out of all active sessions immediately. They cannot use the gateway again until they complete OAuth.

```bash
mcp-admin revoke --email user@example.com
```

- [ ] Sessions revoked

> **Note:** Revoking sessions forces immediate re-authentication. The user cannot use the gateway until they complete the OAuth flow again. This is the right first step if you need to cut access quickly without fully removing the account.

---

### 2. Remove CRM credentials (partial removal - specific entity only)

Use this if the user should lose access to one CRM entity but retain others.

```bash
mcp-admin remove --email user@example.com --entity crm1
```

- [ ] Entity-specific credentials removed

---

### 3. Remove the full profile (all entities)

Deletes the user's profile and all associated CRM credentials across every entity.

```bash
mcp-admin remove --email user@example.com
```

- [ ] Full profile removed

> **Note:** Removing the profile means that even if the user completes OAuth again, they will have no CRM credentials on file and will receive a `403 Forbidden` response from the gateway. A new `mcp-admin add` (or equivalent provisioning step) would be required to restore access.

---

### 4. Verify removal

Confirm the user no longer appears in the gateway user list.

```bash
mcp-admin list --user user@example.com
```

Expected output: empty result or `user not found`.

- [ ] Verification passed - user has no active profile or sessions

---

## Summary of effects

| Action | Immediate effect | After re-auth |
|---|---|---|
| `revoke` only | User is logged out, cannot use gateway | Access restored once OAuth completes |
| `remove --entity` | Loses access to that entity's CRM | 403 for that entity even after re-auth |
| `remove` (full) | Loses all CRM access | 403 on all entities even after re-auth |

---

## Full offboarding (typical case)

For a complete offboard, run all three steps:

```bash
mcp-admin revoke --email user@example.com
mcp-admin remove --email user@example.com
mcp-admin list --user user@example.com
```

- [ ] Sessions revoked
- [ ] Profile removed
- [ ] Verified - no record found
