#!/usr/bin/env bash
# Update crm-hosts.json on the gateway for a given entity.
# Runs on the gateway VM (delegated from Ansible).
#
# Usage:
#   update-crm-host.sh <entity_code> <config_path> <endpoint> <site_url> <ssh_host> <ssh_user> <ssh_key>
#
# Arguments:
#   entity_code  - short entity identifier (e.g. crm1)
#   config_path  - absolute path to config.php on the CRM VM
#   endpoint     - full REST API URL (may be empty; derived from site_url if so)
#   site_url     - CRM site_url from config.php (used to derive endpoint if blank)
#   ssh_host     - SSH hostname/IP of the CRM VM
#   ssh_user     - SSH username for provisioning (default: ubuntu)
#   ssh_key      - path to SSH private key (may be empty to use agent/default)

set -euo pipefail

ENTITY_CODE="${1:?entity_code required}"
CONFIG_PATH="${2:?config_path required}"
ENDPOINT="${3:-}"
SITE_URL="${4:-}"
SSH_HOST="${5:?ssh_host required}"
SSH_USER="${6:-ubuntu}"
SSH_KEY="${7:-}"

HOSTS_FILE="/etc/suitecrm-mcp/crm-hosts.json"

# Derive endpoint from site_url if not provided
if [[ -z "$ENDPOINT" && -n "$SITE_URL" ]]; then
  SITE_URL="${SITE_URL%/}"
  # Try known REST API paths in order of likelihood
  for path in "/legacy/service/v4_1/rest.php" "/service/v4_1/rest.php" "/crm/legacy/service/v4_1/rest.php"; do
    ENDPOINT="${SITE_URL}${path}"
    break
  done
fi

python3 - <<PYEOF
import json
from pathlib import Path

hosts_path = Path("$HOSTS_FILE")
hosts = json.loads(hosts_path.read_text()) if hosts_path.exists() else {}

entry = {
    "ssh_host": "$SSH_HOST",
    "ssh_user": "$SSH_USER",
    "command":  f"SUITECRM_CONFIG=$CONFIG_PATH /usr/local/bin/crm-provision-user",
}
if "$SSH_KEY":
    entry["ssh_key"] = "$SSH_KEY"
if "$ENDPOINT":
    entry["endpoint"] = "$ENDPOINT"

hosts["$ENTITY_CODE"] = entry

tmp = hosts_path.with_suffix(".tmp")
tmp.write_text(json.dumps(hosts, indent=2) + "\n")
tmp.rename(hosts_path)
print(f"Updated {hosts_path} for entity $ENTITY_CODE (ssh_host=$SSH_HOST)")
PYEOF
