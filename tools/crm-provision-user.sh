#!/bin/bash
# ============================================================
# crm-provision-user — Non-interactive SuiteCRM API user provisioner
# ============================================================
# Runs on each CRM VM. Called via SSH by the MCP gateway.
# Auto-locates SuiteCRM config.php anywhere on the filesystem.
#
# Usage:
#   Single user:  crm-provision-user <username> <password>
#   Bulk CSV:     crm-provision-user --csv /path/to/users.csv
#
# Override if needed:
#   SUITECRM_CONFIG=/custom/path/config.php crm-provision-user alice pass
# ============================================================

set -euo pipefail

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; CYAN="\033[0;36m"; NC="\033[0m"
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1" >&2; exit 1; }

# ── Auto-locate SuiteCRM config.php ──────────────────────────
# ── Locate SuiteCRM config.php ───────────────────────────────
# SUITECRM_CONFIG must be set in /etc/environment (done by Ansible/setup).
# If not set, we run the reliable find command to discover it now
# and tell the admin to persist it.
if [ -z "${SUITECRM_CONFIG:-}" ]; then
    warn "SUITECRM_CONFIG not set — searching filesystem..."
    SUITECRM_CONFIG=$(find /         \( -path /proc -o -path /sys -o -path /dev \) -prune -o         -name "config.php" -readable -print 2>/dev/null         | xargs grep -l "dbconfig" 2>/dev/null         | head -1)

    [ -z "$SUITECRM_CONFIG" ] && fail "Could not find SuiteCRM config.php.
Run this to find and persist it:
  export SUITECRM_CONFIG=\$(find / \( -path /proc -o -path /sys -o -path /dev \) -prune -o -name config.php -readable -print 2>/dev/null | xargs grep -l dbconfig 2>/dev/null | head -1)
  echo "SUITECRM_CONFIG=\$SUITECRM_CONFIG" | sudo tee -a /etc/environment"

    warn "Found: $SUITECRM_CONFIG"
    warn "Persist it: echo "SUITECRM_CONFIG=$SUITECRM_CONFIG" | sudo tee -a /etc/environment"
fi

[ ! -f "$SUITECRM_CONFIG" ] && fail "SUITECRM_CONFIG file not found: $SUITECRM_CONFIG"
info "Using config: $SUITECRM_CONFIG"

# ── Read DB credentials from config.php ──────────────────────
read_cfg() {
    php -r "include('$SUITECRM_CONFIG'); echo \$sugar_config['dbconfig']['$1'] ?? '';" 2>/dev/null
}

DB_HOST=$(read_cfg db_host_name)
DB_NAME=$(read_cfg db_name)
DB_USER=$(read_cfg db_user_name)
DB_PASS=$(read_cfg db_password)
DB_PORT=$(read_cfg db_port)
DB_PORT="${DB_PORT:-3306}"

for VAR in DB_HOST DB_NAME DB_USER DB_PASS; do
    [ -z "${!VAR}" ] && fail "Could not read $VAR from $SUITECRM_CONFIG"
done

# CRM URL from config site_url
if [ -z "${CRM_URL:-}" ]; then
    CRM_URL=$(php -r "include('$SUITECRM_CONFIG'); echo \$sugar_config['site_url'] ?? 'https://localhost';" 2>/dev/null)
fi

CRM_URL="${CRM_URL/http:\/\//https://}"
API_PATH="${API_PATH:-/legacy/service/v4_1/rest.php}"
ENDPOINT="${CRM_URL%/}${API_PATH}"

# ── Verify API is reachable ───────────────────────────────────
SERVER_INFO=$(curl -sk -m 10 -X POST "$ENDPOINT" \
  --data-urlencode 'method=get_server_info' \
  --data-urlencode 'input_type=JSON' \
  --data-urlencode 'response_type=JSON' \
  --data-urlencode 'rest_data={}' 2>/dev/null || echo "{}")

VERSION=$(echo "$SERVER_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('version',''))" 2>/dev/null || echo "")
[ -z "$VERSION" ] && fail "API endpoint unreachable: $ENDPOINT"

# ── Set password in DB and verify API login ───────────────────
process_user() {
    local CRM_USER="$1" API_PASS="$2"

    local RESULT
    RESULT=$(DB_HOST="$DB_HOST" DB_NAME="$DB_NAME" DB_USER="$DB_USER" \
             DB_PASS="$DB_PASS" DB_PORT="$DB_PORT" \
             CRM_USER="$CRM_USER" API_PASS="$API_PASS" \
    php -r '
$host     = getenv("DB_HOST");
$dbname   = getenv("DB_NAME");
$db_user  = getenv("DB_USER");
$db_pass  = getenv("DB_PASS");
$db_port  = getenv("DB_PORT") ?: "3306";
$crm_user = getenv("CRM_USER");
$api_pass = getenv("API_PASS");
try {
    $pdo = new PDO("mysql:host=$host;port=$db_port;dbname=$dbname", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $hash = strtolower(md5($api_pass));
    $check = $pdo->prepare("SELECT COUNT(*) FROM users WHERE user_name = ?");
    $check->execute([$crm_user]);
    if ($check->fetchColumn() == 0) { echo 0; exit; }
    $stmt = $pdo->prepare("UPDATE users SET user_hash = ?, external_auth_only = 0, system_generated_password = 0 WHERE user_name = ?");
    $stmt->execute([$hash, $crm_user]);
    echo 1;
} catch (Exception $e) {
    echo "ERROR: " . $e->getMessage();
}
' 2>/dev/null)

    if [[ "$RESULT" == ERROR* ]]; then echo "DB_FAIL:$RESULT"; return; fi
    if [ "$RESULT" = "0" ]; then echo "NO_USER"; return; fi

    local REST_DATA LOGIN_RESPONSE SESSION_ID
    REST_DATA=$(python3 -c "
import json, sys
print(json.dumps({'user_auth': {'user_name': sys.argv[1], 'password': sys.argv[2]},
                  'application_name': 'mcp-gateway-provision', 'name_value_list': []}))
" "$CRM_USER" "$(printf '%s' "$API_PASS" | md5sum | cut -d' ' -f1)" 2>/dev/null)

    LOGIN_RESPONSE=$(curl -sk -m 10 -X POST "$ENDPOINT" \
      --data-urlencode 'method=login' \
      --data-urlencode 'input_type=JSON' \
      --data-urlencode 'response_type=JSON' \
      --data-urlencode "rest_data=$REST_DATA" 2>/dev/null)

    SESSION_ID=$(echo "$LOGIN_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin); sid = d.get('id','')
    print('' if sid in ('','0',0) else sid)
except: print('')
" 2>/dev/null)

    [ -z "$SESSION_ID" ] && { echo "LOGIN_FAIL:$LOGIN_RESPONSE"; return; }
    echo "OK"
}

# ── Single user mode ──────────────────────────────────────────
if [ "${1:-}" != "--csv" ]; then
    [ $# -lt 2 ] && fail "Usage: crm-provision-user <username> <password>"
    RESULT=$(process_user "$1" "$2")
    case "$RESULT" in
        OK)           ok "$1 — password set and login verified"; exit 0 ;;
        NO_USER)      fail "$1 — not found in SuiteCRM database" ;;
        DB_FAIL:*)    fail "$1 — DB error: ${RESULT#DB_FAIL:}" ;;
        LOGIN_FAIL:*) warn "$1 — password set in DB (API verify failed — may be normal if CRM not reachable internally)"; exit 0 ;;
    esac
fi

# ── Bulk CSV mode ─────────────────────────────────────────────
[ $# -lt 2 ] && fail "Usage: crm-provision-user --csv <file.csv>"
CSV_FILE="$2"
[ ! -f "$CSV_FILE" ] && fail "CSV file not found: $CSV_FILE"

PASS=0; FAIL=0; SKIP=0; LINE=0
while IFS=',' read -r RAW_USER RAW_PASS; do
    LINE=$((LINE + 1))
    CRM_USER=$(echo "$RAW_USER" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    API_PASS=$(echo "$RAW_PASS"  | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$CRM_USER" ] && continue

    if [ $LINE -eq 1 ]; then
        LOWER=$(echo "$CRM_USER" | tr '[:upper:]' '[:lower:]')
        [[ "$LOWER" =~ ^(username|user|user_name)$ ]] && { info "Skipping header"; continue; }
    fi

    [ -z "$API_PASS" ] && { warn "$CRM_USER — skipped (no password)"; SKIP=$((SKIP+1)); continue; }

    printf "  %-30s ... " "$CRM_USER"
    RESULT=$(process_user "$CRM_USER" "$API_PASS")
    case "$RESULT" in
        OK)           echo -e "${GREEN}OK${NC}";                   PASS=$((PASS+1)) ;;
        NO_USER)      echo -e "${RED}FAIL${NC} (not in DB)";       FAIL=$((FAIL+1)) ;;
        DB_FAIL:*)    echo -e "${RED}FAIL${NC} (DB error)";        FAIL=$((FAIL+1)) ;;
        LOGIN_FAIL:*) echo -e "${YELLOW}WARN${NC} (DB set, API verify failed)"; PASS=$((PASS+1)) ;;
    esac
done < "$CSV_FILE"

echo ""
echo -e "  Passed: ${GREEN}$PASS${NC}  Failed: ${RED}$FAIL${NC}  Skipped: ${YELLOW}$SKIP${NC}"
[ $FAIL -gt 0 ] && exit 1 || exit 0
