#!/usr/bin/env bash
# Find the SuiteCRM config.php with the highest active user count.
# Runs on the CRM VM. Prints the absolute path to config.php, or exits 1.

set -euo pipefail

# Search common SuiteCRM install roots
CANDIDATES=()
while IFS= read -r -d '' f; do
  CANDIDATES+=("$f")
done < <(find / \( -path /proc -o -path /sys -o -path /dev \) -prune -o \
         -name 'config.php' -readable -print0 2>/dev/null | \
         xargs -0 grep -l 'dbconfig\|sugar_config' 2>/dev/null || true)

if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
  echo "ERROR: No SuiteCRM config.php found under /var/www /srv /opt /home" >&2
  exit 1
fi

BEST=""
BEST_COUNT=-1

for f in "${CANDIDATES[@]}"; do
  COUNT=$(php -r "
    @include('$f');
    \$db_host = \$sugar_config['dbconfig']['db_host_name'] ?? \$sugar_config['db_host_name'] ?? '';
    \$db_name = \$sugar_config['dbconfig']['db_name'] ?? \$sugar_config['db_name'] ?? '';
    \$db_user = \$sugar_config['dbconfig']['db_user_name'] ?? \$sugar_config['db_user_name'] ?? '';
    \$db_pass = \$sugar_config['dbconfig']['db_password'] ?? \$sugar_config['db_password'] ?? '';
    if (empty(\$db_name)) { echo -1; exit; }
    try {
      \$pdo = new PDO(
        'mysql:host=' . \$db_host . ';dbname=' . \$db_name,
        \$db_user, \$db_pass,
        [PDO::ATTR_TIMEOUT => 3, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
      );
      echo (int)\$pdo->query('SELECT COUNT(*) FROM users WHERE deleted=0 AND status=\"Active\"')->fetchColumn();
    } catch (Exception \$e) { echo 0; }
  " 2>/dev/null || echo -1)
  COUNT=$(echo "$COUNT" | tr -d '[:space:]')
  if [[ "$COUNT" =~ ^[0-9]+$ ]] && (( COUNT > BEST_COUNT )); then
    BEST="$f"
    BEST_COUNT=$COUNT
  fi
done

if [[ -z "$BEST" ]]; then
  # Fall back to first candidate if none could connect to DB
  BEST="${CANDIDATES[0]}"
fi

echo "$BEST"
