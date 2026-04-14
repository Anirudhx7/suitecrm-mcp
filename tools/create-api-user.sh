#!/bin/bash
# ============================================================
# SuiteCRM API Password Tool
# ============================================================
# Sets a local API password for an LDAP/SSO user in the
# SuiteCRM database, then verifies login via the v4.1 REST API.
#
# Background: SuiteCRM's v4.1 REST API authenticates against
# the local DB password (user_hash). LDAP/SSO users have no
# local password by default, so they cannot use the REST API.
# This script sets one without touching their LDAP login.
#
# Requirements: bash, php (with PDO MySQL), curl, python3
#
# Usage:
#   Single user (interactive):
#     ./create-api-user.sh
#
#   Bulk from CSV:
#     ./create-api-user.sh --csv users.csv
#
#   CSV format (header row optional, auto-detected):
#     username,password
#     jsmith,SecurePass1
#     bjones,SecurePass2
# ============================================================

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; CYAN="\033[0;36m"; NC="\033[0m"
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

CSV_FILE=""
if [ "$1" = "--csv" ]; then
    [ -z "$2" ] && fail "Usage: $0 --csv <file.csv>"
    [ ! -f "$2" ] && fail "CSV file not found: $2"
    CSV_FILE="$2"
fi

echo ""
echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}  SuiteCRM API Password Tool${NC}"
[ -n "$CSV_FILE" ] && echo -e "${CYAN}  Mode: Bulk CSV - $CSV_FILE${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""

# ── Collect CRM + DB config ───────────────────────────────────
info "Enter CRM details:"
echo ""

read -rp "  CRM URL (e.g. https://crm.example.com): " CRM_URL
CRM_URL="${CRM_URL%/}"
[ -z "$CRM_URL" ] && fail "CRM URL cannot be empty"

read -rp "  CRM REST API path (default: /legacy/service/v4_1/rest.php): " API_PATH
API_PATH="${API_PATH:-/legacy/service/v4_1/rest.php}"
ENDPOINT="${CRM_URL}${API_PATH}"

echo ""
info "Enter database details:"
echo ""

read -rp "  DB Host: " DB_HOST
read -rp "  DB Name: " DB_NAME
read -rp "  DB User: " DB_USER
read -rsp "  DB Password: " DB_PASS
echo ""

[ -z "$DB_HOST" ] && fail "DB Host cannot be empty"
[ -z "$DB_NAME" ] && fail "DB Name cannot be empty"
[ -z "$DB_USER" ] && fail "DB User cannot be empty"

# ── Check API endpoint reachable once, before processing ──────
echo ""
info "Checking API endpoint..."

SERVER_INFO=$(curl -sk -X POST "$ENDPOINT" \
  --data-urlencode 'method=get_server_info' \
  --data-urlencode 'input_type=JSON' \
  --data-urlencode 'response_type=JSON' \
  --data-urlencode 'rest_data={}' 2>/dev/null)

VERSION=$(echo "$SERVER_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('version','unknown'))" 2>/dev/null)
if [ -z "$VERSION" ] || [ "$VERSION" = "None" ]; then
    fail "API endpoint not reachable or returned unexpected response: $ENDPOINT"
fi
ok "API reachable - SuiteCRM $VERSION"

# ── Helper: set password + test login for one user ────────────
# Outputs: "OK", "NO_USER", "DB_FAIL:<msg>", "LOGIN_FAIL:<response>"
process_user() {
    local CRM_USER="$1"
    local API_PASS="$2"

    # Pass all credentials via env vars - never interpolate them into PHP source code
    local RESULT
    RESULT=$(DB_HOST="$DB_HOST" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASS="$DB_PASS" \
             CRM_USER="$CRM_USER" API_PASS="$API_PASS" \
    php -r '
$host     = getenv("DB_HOST");
$dbname   = getenv("DB_NAME");
$db_user  = getenv("DB_USER");
$db_pass  = getenv("DB_PASS");
$crm_user = getenv("CRM_USER");
$api_pass = getenv("API_PASS");
try {
    $pdo = new PDO("mysql:host=$host;dbname=$dbname", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $hash = strtolower(md5($api_pass));
    $stmt = $pdo->prepare("UPDATE users SET user_hash = ?, external_auth_only = 0, system_generated_password = 0 WHERE user_name = ?");
    $stmt->execute([$hash, $crm_user]);
    echo $stmt->rowCount();
} catch (Exception $e) {
    echo "ERROR: " . $e->getMessage();
}
' 2>/dev/null)

    if [[ "$RESULT" == ERROR* ]]; then
        echo "DB_FAIL:$RESULT"; return
    elif [ "$RESULT" = "0" ]; then
        echo "NO_USER"; return
    fi

    local MD5_PASS
    MD5_PASS=$(printf '%s' "$API_PASS" | md5sum | cut -d' ' -f1)

    # Build login JSON via python3 - avoids shell/JSON injection from usernames with special chars
    local REST_DATA
    REST_DATA=$(python3 -c "
import json, sys
print(json.dumps({'user_auth': {'user_name': sys.argv[1], 'password': sys.argv[2]},
                  'application_name': 'crm-test', 'name_value_list': []}))
" "$CRM_USER" "$MD5_PASS" 2>/dev/null)

    local LOGIN_RESPONSE SESSION_ID
    LOGIN_RESPONSE=$(curl -sk -X POST "$ENDPOINT" \
      --data-urlencode 'method=login' \
      --data-urlencode 'input_type=JSON' \
      --data-urlencode 'response_type=JSON' \
      --data-urlencode "rest_data=$REST_DATA" \
      2>/dev/null)

    SESSION_ID=$(echo "$LOGIN_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    sid = d.get('id', '')
    print('' if sid in ('', '0', 0) else sid)
except: print('')
" 2>/dev/null)

    if [ -z "$SESSION_ID" ]; then
        echo "LOGIN_FAIL:$LOGIN_RESPONSE"
    else
        echo "OK"
    fi
}

# ── Single-user mode ──────────────────────────────────────────
if [ -z "$CSV_FILE" ]; then
    echo ""
    info "Enter user details:"
    echo ""

    read -rp "  CRM Username (LDAP user): " CRM_USER
    read -rsp "  API Password to set: " API_PASS
    echo ""

    [ -z "$CRM_USER" ] && fail "CRM Username cannot be empty"
    [ -z "$API_PASS" ] && fail "API Password cannot be empty"

    echo ""
    echo -e "${CYAN}================================================${NC}"
    echo -e "${CYAN}  Configuration Summary${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo "  CRM URL  : $CRM_URL"
    echo "  API Path : $API_PATH"
    echo "  DB       : $DB_HOST / $DB_NAME"
    echo "  User     : $CRM_USER"
    echo ""

    read -rp "Proceed? [y/N]: " CONFIRM
    [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ] && { info "Aborted."; exit 0; }
    echo ""

    RESULT=$(process_user "$CRM_USER" "$API_PASS")
    case "$RESULT" in
        OK)         ok "Password set and login verified for '$CRM_USER'" ;;
        NO_USER)    fail "No user found with username '$CRM_USER' in database" ;;
        DB_FAIL:*)  fail "Database error: ${RESULT#DB_FAIL:}" ;;
        LOGIN_FAIL:*) fail "Password set in DB but login test failed. Response: ${RESULT#LOGIN_FAIL:}" ;;
    esac
    echo ""
    exit 0
fi

# ── Bulk CSV mode ─────────────────────────────────────────────
echo ""
info "Configuration summary:"
echo "  CRM URL  : $CRM_URL"
echo "  API Path : $API_PATH"
echo "  DB       : $DB_HOST / $DB_NAME"
echo "  CSV file : $CSV_FILE"
echo ""

read -rp "Proceed with all users in CSV? [y/N]: " CONFIRM
[ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ] && { info "Aborted."; exit 0; }
echo ""

PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
declare -a RESULTS=()
LINE_NUM=0

while IFS=',' read -r RAW_USER RAW_PASS; do
    LINE_NUM=$((LINE_NUM + 1))
    CRM_USER=$(echo "$RAW_USER" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    API_PASS=$(echo "$RAW_PASS"  | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    [ -z "$CRM_USER" ] && continue

    # Auto-skip header row
    if [ $LINE_NUM -eq 1 ]; then
        LOWER=$(echo "$CRM_USER" | tr '[:upper:]' '[:lower:]')
        if [ "$LOWER" = "username" ] || [ "$LOWER" = "user" ] || [ "$LOWER" = "user_name" ]; then
            info "Skipping header row"; continue
        fi
    fi

    if [ -z "$API_PASS" ]; then
        warn "  [$CRM_USER] Skipped - no password in CSV"
        RESULTS+=("SKIP|$CRM_USER|no password in CSV")
        SKIP_COUNT=$((SKIP_COUNT + 1)); continue
    fi

    printf "  Processing %-30s ... " "$CRM_USER"
    RESULT=$(process_user "$CRM_USER" "$API_PASS")
    case "$RESULT" in
        OK)
            echo -e "${GREEN}OK${NC}"
            RESULTS+=("OK|$CRM_USER|login verified")
            PASS_COUNT=$((PASS_COUNT + 1)) ;;
        NO_USER)
            echo -e "${RED}FAIL${NC} (user not found in DB)"
            RESULTS+=("FAIL|$CRM_USER|user not found in DB")
            FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
        DB_FAIL:*)
            echo -e "${RED}FAIL${NC} (DB error)"
            RESULTS+=("FAIL|$CRM_USER|DB error: ${RESULT#DB_FAIL:}")
            FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
        LOGIN_FAIL:*)
            echo -e "${YELLOW}WARN${NC} (password set but login test failed)"
            RESULTS+=("WARN|$CRM_USER|password set but login test failed")
            FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    esac
done < "$CSV_FILE"

# ── Results table ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}  Results${NC}"
echo -e "${CYAN}================================================${NC}"
printf "  %-30s  %-6s  %s\n" "Username" "Status" "Detail"
printf "  %-30s  %-6s  %s\n" "------------------------------" "------" "------"
for ROW in "${RESULTS[@]}"; do
    IFS='|' read -r STATUS USER DETAIL <<< "$ROW"
    case "$STATUS" in
        OK)   COLOR="$GREEN" ;;
        WARN) COLOR="$YELLOW" ;;
        SKIP) COLOR="$CYAN" ;;
        *)    COLOR="$RED" ;;
    esac
    printf "  %-30s  ${COLOR}%-6s${NC}  %s\n" "$USER" "$STATUS" "$DETAIL"
done

echo ""
echo -e "  Passed : ${GREEN}$PASS_COUNT${NC}"
[ $FAIL_COUNT -gt 0 ] && echo -e "  Failed : ${RED}$FAIL_COUNT${NC}" || echo "  Failed : $FAIL_COUNT"
[ $SKIP_COUNT -gt 0 ] && echo -e "  Skipped: ${YELLOW}$SKIP_COUNT${NC}" || echo "  Skipped: $SKIP_COUNT"
echo ""
