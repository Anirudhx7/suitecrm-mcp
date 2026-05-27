#!/usr/bin/env bash
# =============================================================================
# mcp_acl_setup.sh
# Automatically locates a SuiteCRM config.php, extracts DB credentials,
# fixes OAuth2 token lifetime to 30 days, and creates the mcp_acl_reader
# service user.
#
# Run once directly — no install needed:
#   chmod +x mcp_acl_setup.sh && sudo ./mcp_acl_setup.sh
#
# Options:
#   -p, --password PASSWORD   Password for mcp_acl_reader (prompted if omitted)
#   -c, --config PATH         Skip auto-detect; use this config.php directly
#   -t, --token-only          Only fix the OAuth2 token lifetime, skip user creation
#   -u, --user-only           Only create/verify user, skip token fix
#   -n, --dry-run             Print SQL that would run, but don't execute it
#   -v, --verbose             Print extra debug info
#   -h, --help                Show this help
# =============================================================================

set -euo pipefail

# --------------------------------------------------------------------------- #
# Colour helpers
# --------------------------------------------------------------------------- #
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
err()     { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { err "$*"; exit 1; }
verbose() { [[ "${VERBOSE:-0}" == "1" ]] && echo -e "${BOLD}[DEBUG]${RESET} $*" || true; }

# --------------------------------------------------------------------------- #
# Defaults
# --------------------------------------------------------------------------- #
MCP_PASS=""
FORCE_CONFIG=""
DO_TOKEN=1
DO_USER=1
DRY_RUN=0
VERBOSE=0

# --------------------------------------------------------------------------- #
# Parse arguments
# --------------------------------------------------------------------------- #
usage() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--password)   MCP_PASS="$2";       shift 2 ;;
    -c|--config)     FORCE_CONFIG="$2";   shift 2 ;;
    -t|--token-only) DO_USER=0;           shift   ;;
    -u|--user-only)  DO_TOKEN=0;          shift   ;;
    -n|--dry-run)    DRY_RUN=1;           shift   ;;
    -v|--verbose)    VERBOSE=1;           shift   ;;
    -h|--help)       usage ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
done

# --------------------------------------------------------------------------- #
# Dependency checks
# --------------------------------------------------------------------------- #
for cmd in php mysql; do
  command -v "$cmd" &>/dev/null || die "'$cmd' not found — please install it first."
done

# --------------------------------------------------------------------------- #
# Helper: run or print SQL
# --------------------------------------------------------------------------- #
run_sql() {
  local host="$1" user="$2" pass="$3" db="$4" sql="$5"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo -e "${YELLOW}[DRY-RUN SQL]${RESET}\n$sql\n"
    return 0
  fi
  mysql -h "$host" -u "$user" -p"$pass" "$db" -e "$sql"
}

# --------------------------------------------------------------------------- #
# Helper: check if a config.php is a valid SuiteCRM config with reachable DB
# Returns the active user count (>=0) or -1 on failure.
# --------------------------------------------------------------------------- #
score_config() {
  local f="$1"
  php -r "
    @include('$f');
    \$h = \$sugar_config['dbconfig']['db_host_name'] ?? \$sugar_config['db_host_name'] ?? '';
    \$u = \$sugar_config['dbconfig']['db_user_name'] ?? \$sugar_config['db_user_name'] ?? '';
    \$p = \$sugar_config['dbconfig']['db_password']  ?? \$sugar_config['db_password']  ?? '';
    \$d = \$sugar_config['dbconfig']['db_name']       ?? \$sugar_config['db_name']       ?? '';
    if (empty(\$d)) { echo -1; exit; }
    try {
      \$pdo = new PDO(
        'mysql:host=' . \$h . ';dbname=' . \$d,
        \$u, \$p,
        [PDO::ATTR_TIMEOUT => 3, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
      );
      echo (int)\$pdo->query('SELECT COUNT(*) FROM users WHERE deleted=0 AND status=\"Active\"')->fetchColumn();
    } catch (Exception \$e) { echo 0; }
  " 2>/dev/null | tr -d '[:space:]'
}

# --------------------------------------------------------------------------- #
# STEP 1 — Locate config.php
# --------------------------------------------------------------------------- #
find_best_config() {
  # Fast-path: check common SuiteCRM install locations first.
  # SuiteCRM 8.x keeps config.php inside a 'legacy/' subdirectory.
  # Checking these globs avoids the slow full-filesystem scan in most cases.
  local FAST_GLOBS=(
    /var/www/*/legacy/config.php
    /var/www/html/*/legacy/config.php
    /var/www/html/legacy/config.php
    /srv/www/*/legacy/config.php
    /srv/www/html/*/legacy/config.php
    /opt/suitecrm*/legacy/config.php
    /opt/*/legacy/config.php
    /home/*/public_html/legacy/config.php
    # SuiteCRM 7.x (no legacy/ subdir)
    /var/www/*/config.php
    /var/www/html/config.php
    /var/www/html/*/config.php
    /opt/suitecrm*/config.php
  )

  local FAST_BEST="" FAST_BEST_COUNT=-1
  info "Checking common SuiteCRM install paths …"
  for glob in "${FAST_GLOBS[@]}"; do
    for f in $glob; do
      [[ -f "$f" && -r "$f" ]] || continue
      # Quick text check before running PHP
      grep -ql 'sugar_config\|dbconfig' "$f" 2>/dev/null || continue
      verbose "Fast-path candidate: $f"
      COUNT=$(score_config "$f")
      COUNT="${COUNT:-"-1"}"
      verbose "  score: $COUNT"
      if [[ "$COUNT" =~ ^[0-9]+$ ]] && (( COUNT > FAST_BEST_COUNT )); then
        FAST_BEST="$f"
        FAST_BEST_COUNT=$COUNT
      fi
    done
  done

  if [[ -n "$FAST_BEST" ]]; then
    verbose "Fast-path found: $FAST_BEST (score $FAST_BEST_COUNT)"
    echo "$FAST_BEST"
    return
  fi

  # Slow-path: full filesystem scan as fallback
  warn "No config found in common paths — falling back to full filesystem scan (may take ~30 s) …"
  warn "Tip: pass -c /path/to/legacy/config.php to skip auto-detect."

  local CANDIDATES=()
  while IFS= read -r -d '' f; do
    CANDIDATES+=("$f")
  done < <(find / \( -path /proc -o -path /sys -o -path /dev \) -prune -o \
           -name 'config.php' -readable -print0 2>/dev/null | \
           xargs -0 grep -l 'dbconfig\|sugar_config' 2>/dev/null || true)

  if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
    die "No SuiteCRM config.php found. Use -c /path/to/config.php to specify it manually."
  fi

  verbose "Full scan candidates: ${#CANDIDATES[@]}"

  # Prefer paths containing 'legacy/' — that's where SuiteCRM 8.x puts config.php
  local SORTED=()
  for f in "${CANDIDATES[@]}"; do
    [[ "$f" == */legacy/config.php ]] && SORTED=("$f" "${SORTED[@]}") || SORTED+=("$f")
  done

  local BEST="" BEST_COUNT=-1
  for f in "${SORTED[@]}"; do
    verbose "Scoring: $f"
    COUNT=$(score_config "$f")
    COUNT="${COUNT:-"-1"}"
    verbose "  score: $COUNT"
    if [[ "$COUNT" =~ ^[0-9]+$ ]] && (( COUNT > BEST_COUNT )); then
      BEST="$f"
      BEST_COUNT=$COUNT
    fi
  done

  if [[ -z "$BEST" ]]; then
    die "Found config.php files but none could connect to a database. Use -c /path/to/config.php."
  fi

  echo "$BEST"
}

# --------------------------------------------------------------------------- #
# STEP 2 — Extract DB credentials from config.php
# --------------------------------------------------------------------------- #
extract_credentials() {
  local config="$1"
  verbose "Extracting credentials from: $config"

  read -r DB_HOST DB_USER DB_PASS DB_NAME < <(php -r "
    @include('$config');
    \$h = \$sugar_config['dbconfig']['db_host_name'] ?? \$sugar_config['db_host_name'] ?? '';
    \$u = \$sugar_config['dbconfig']['db_user_name'] ?? \$sugar_config['db_user_name'] ?? '';
    \$p = \$sugar_config['dbconfig']['db_password']  ?? \$sugar_config['db_password']  ?? '';
    \$d = \$sugar_config['dbconfig']['db_name']       ?? \$sugar_config['db_name']       ?? '';
    echo implode(' ', [escapeshellarg(\$h), escapeshellarg(\$u), escapeshellarg(\$p), escapeshellarg(\$d)]);
  " 2>/dev/null | xargs -n4)

  # Strip surrounding single-quotes added by escapeshellarg
  DB_HOST="${DB_HOST//\'/}"; DB_USER="${DB_USER//\'/}"
  DB_PASS="${DB_PASS//\'/}"; DB_NAME="${DB_NAME//\'/}"

  [[ -n "$DB_HOST" && -n "$DB_NAME" ]] || die "Could not parse DB credentials from $config"

  # If host is 'localhost' and socket errors occur, fall back to 127.0.0.1
  if ! mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT 1" &>/dev/null 2>&1; then
    verbose "TCP connect to '$DB_HOST' failed — retrying with 127.0.0.1"
    DB_HOST="127.0.0.1"
    mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT 1" &>/dev/null \
      || die "Cannot connect to database even via 127.0.0.1 — check credentials."
  fi

  export DB_HOST DB_USER DB_PASS DB_NAME
}

# --------------------------------------------------------------------------- #
# STEP 3 — Fix OAuth2 token lifetime
# --------------------------------------------------------------------------- #
fix_token_lifetime() {
  info "Checking current OAuth2 token lifetime …"

  CURRENT=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" \
    -sNe "SELECT CONCAT(duration_value,' ',duration_unit) FROM oauth2clients WHERE deleted=0 LIMIT 1;" \
    2>/dev/null || echo "unknown")
  info "Current lifetime: $CURRENT"

  if [[ "$CURRENT" == "30 day" ]]; then
    ok "Token lifetime is already 30 days — no change needed."
    return
  fi

  run_sql "$DB_HOST" "$DB_USER" "$DB_PASS" "$DB_NAME" \
    "UPDATE oauth2clients SET duration_value=30, duration_amount=30, duration_unit='day' WHERE deleted=0;"

  if [[ "$DRY_RUN" == "0" ]]; then
    VERIFY=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" \
      -sNe "SELECT CONCAT(duration_value,' ',duration_unit) FROM oauth2clients WHERE deleted=0 LIMIT 1;" \
      2>/dev/null || echo "")
    [[ "$VERIFY" == "30 day" ]] \
      && ok "OAuth2 token lifetime updated to 30 days." \
      || warn "Update ran but verify returned: '$VERIFY'"
  fi
}

# --------------------------------------------------------------------------- #
# STEP 4 — Create mcp_acl_reader service user
# --------------------------------------------------------------------------- #
create_service_user() {
  info "Checking if mcp_acl_reader already exists …"

  EXISTS=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" \
    -sNe "SELECT COUNT(*) FROM users WHERE user_name='mcp_acl_reader' AND deleted=0;" \
    2>/dev/null || echo "0")

  if [[ "$EXISTS" -gt 0 ]]; then
    ok "mcp_acl_reader already exists — skipping INSERT."
  else
    info "Creating mcp_acl_reader …"
    run_sql "$DB_HOST" "$DB_USER" "$DB_PASS" "$DB_NAME" \
      "INSERT INTO users (id, user_name, first_name, last_name, status, is_admin, sugar_login, date_entered, date_modified, deleted)
       VALUES (UUID(), 'mcp_acl_reader', 'MCP', 'ACL Reader', 'Active', 0, 1, NOW(), NOW(), 0);"
  fi

  # Set / reset password
  info "Setting password for mcp_acl_reader …"
  run_sql "$DB_HOST" "$DB_USER" "$DB_PASS" "$DB_NAME" \
    "UPDATE users SET user_hash=MD5('${MCP_PASS//\'/\'\\\'\'}') WHERE user_name='mcp_acl_reader';"

  if [[ "$DRY_RUN" == "0" ]]; then
    info "Verifying user …"
    mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" \
      -e "SELECT id, user_name, first_name, last_name, status, is_admin
          FROM users WHERE user_name='mcp_acl_reader';"
    ok "mcp_acl_reader is ready."
  fi
}

# --------------------------------------------------------------------------- #
# MAIN
# --------------------------------------------------------------------------- #
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║        SuiteCRM mcp_acl_setup.sh         ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

[[ "$DRY_RUN" == "1" ]] && warn "DRY-RUN mode — no changes will be made."

# --- Locate config ---
if [[ -n "$FORCE_CONFIG" ]]; then
  [[ -f "$FORCE_CONFIG" ]] || die "Specified config not found: $FORCE_CONFIG"
  CONFIG_PATH="$FORCE_CONFIG"
  info "Using specified config: $CONFIG_PATH"
else
  CONFIG_PATH=$(find_best_config)
fi
ok "Using config: $CONFIG_PATH"

# --- Extract credentials ---
extract_credentials "$CONFIG_PATH"
info "Database: $DB_NAME on $DB_HOST (user: $DB_USER)"

# --- Prompt for MCP password if needed ---
if [[ "$DO_USER" == "1" && -z "$MCP_PASS" ]]; then
  echo ""
  while true; do
    read -rsp "$(echo -e "${BOLD}Enter password for mcp_acl_reader:${RESET} ")" MCP_PASS; echo
    read -rsp "$(echo -e "${BOLD}Confirm password:${RESET} ")" MCP_PASS2; echo
    [[ "$MCP_PASS" == "$MCP_PASS2" ]] && break
    warn "Passwords do not match — try again."
  done
  [[ -n "$MCP_PASS" ]] || die "Password cannot be empty."
fi

echo ""

# --- Run requested steps ---
[[ "$DO_TOKEN" == "1" ]] && fix_token_lifetime && echo ""
[[ "$DO_USER"  == "1" ]] && create_service_user && echo ""

echo -e "${GREEN}${BOLD}All done.${RESET}"
echo ""
