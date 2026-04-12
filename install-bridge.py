#!/usr/bin/env python3
"""
SuiteCRM MCP Bridge Installer for OpenClaw
==========================================
Runs on the OpenClaw machine. Installs per-user bridge plugins that
connect OpenClaw to a remote suitecrm-mcp gateway via SSE.

Compatible with suitecrm-mcp gateway v1.2+.

Usage:
  # Single entity
  sudo python3 install-bridge.py --gateway http://GATEWAY_HOST:3101 --code mycrm --label "My CRM"

  # Multi entity (reads entities.json — same format as install-multi.py)
  sudo python3 install-bridge.py --gateway http://GATEWAY_HOST:8080 --entities entities.json

  # Target specific users (default: all users in /home)
  sudo python3 install-bridge.py --gateway ... --entities entities.json user1 user2

  # Remove bridge from users
  sudo python3 install-bridge.py --remove user1 user2 --gateway ... --entities entities.json

  # Reinstall bridge plugins (preserves credentials)
  sudo python3 install-bridge.py --update --gateway ... --entities entities.json
"""

import os, sys, subprocess, json, argparse, re, shutil
from pathlib import Path
from urllib.parse import urlparse

SETUP_SCRIPT = "/usr/local/bin/suitecrm-setup"

RED = "\033[0;31m"; GREEN = "\033[0;32m"; YELLOW = "\033[1;33m"; CYAN = "\033[0;36m"; NC = "\033[0m"
def info(m): print(f"{CYAN}[INFO]{NC} {m}")
def ok(m):   print(f"{GREEN}[OK]{NC} {m}")
def warn(m): print(f"{YELLOW}[WARN]{NC} {m}")
def error(m): print(f"{RED}[ERROR]{NC} {m}"); sys.exit(1)

SAFE_CODE_RE  = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$')
SAFE_LABEL_RE = re.compile(r'^[a-zA-Z0-9 _.,()\-]+$')
SAFE_USER_RE  = re.compile(r'^[a-zA-Z0-9_-]+$')

def validate_code(c):
    if not SAFE_CODE_RE.match(c):
        error(f"Invalid entity code: {c!r} — use letters, digits, hyphens, underscores only")

def validate_label(l):
    if not SAFE_LABEL_RE.match(l):
        error(f"Invalid entity label: {l!r} — use letters, digits, spaces, and basic punctuation only")

def validate_username(u):
    if not SAFE_USER_RE.match(u):
        error(f"Invalid username: {u!r} — use letters, digits, hyphens, underscores only")

def validate_gateway_url(url):
    url = url.rstrip('/')
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        error(f"Invalid gateway URL: {url!r} — must start with http:// or https://")
    if not parsed.netloc:
        error(f"Invalid gateway URL: {url!r} — missing host")
    # Reject any path component — the bridge constructs its own paths
    if parsed.path not in ('', '/'):
        error(
            f"Invalid gateway URL: {url!r} — must be a bare origin with no path "
            f"(e.g. http://host:8080, not http://host:8080/some/path)"
        )
    return url

def run(cmd, check=True, capture=False, cwd=None):
    # All privileged subprocess calls must use list form to prevent shell injection.
    # String commands are never allowed here — use list form for every call.
    if isinstance(cmd, str):
        raise ValueError(f"run() requires a list command, got string: {cmd!r}")
    r = subprocess.run(cmd, capture_output=capture, text=True, cwd=cwd)
    if check and r.returncode != 0:
        error(f"Command failed: {' '.join(str(c) for c in cmd)}\n{r.stderr.strip() if capture else ''}")
    return r

def write_file(path, content, owner=None, mode=None):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f: f.write(content)
    if owner: run(["chown", f"{owner}:{owner}", path])
    if mode:  run(["chmod", mode, path])

def check_node():
    if not shutil.which("node"):
        error("Node.js not found. Install OpenClaw first — it requires Node.js.")
    ok(f"Node.js: {run(['node', '--version'], capture=True).stdout.strip()}")

def load_entities(args):
    """Return {code: label} from --entities file or --code/--label args."""
    if args.entities:
        if not Path(args.entities).exists():
            error(f"entities file not found: {args.entities}")
        with open(args.entities) as f:
            data = json.load(f)
        entities = {}
        for code, val in data.items():
            validate_code(code)
            label = val.get("label", code) if isinstance(val, dict) else str(val)
            validate_label(label)
            entities[code] = label
        if not entities:
            error("entities file is empty")
        return entities
    elif args.code:
        validate_code(args.code)
        label = args.label or args.code
        validate_label(label)
        return {args.code: label}
    else:
        error("Specify --entities entities.json (multi) or --code CODE --label LABEL (single)")


def _make_bridge_js(code, label, gateway_url, is_multi):
    """Generate the OpenClaw plugin JS for one entity."""
    tool_suffixes = [
        "search", "search_text", "get", "create", "update", "delete",
        "count", "get_relationships", "link_records", "unlink_records",
        "get_module_fields", "list_modules", "server_info",
    ]
    tool_names = json.dumps([f"suitecrm_{code}_{s}" for s in tool_suffixes])
    sse_url = f"{gateway_url}/{code}/sse" if is_multi else f"{gateway_url}/sse"

    return f"""/**
 * SuiteCRM Bridge Plugin for OpenClaw
 * Entity : {label} ({code})
 * Gateway: {gateway_url}
 * Creds  : ~/.suitecrm-mcp/{code}.json
 *
 * Compatible with suitecrm-mcp gateway v1.2+
 *
 * Gateway behaviour this bridge accounts for:
 *   - Fail-fast auth: gateway validates CRM credentials before opening the SSE
 *     stream. Bad credentials return HTTP 401 JSON — not an SSE event. The
 *     bridge detects this and stops retrying (credentials won't self-heal;
 *     the user must re-run suitecrm-setup).
 *   - Rate limit on /sse: 20 requests per 15 minutes. A nextRetryAt timestamp
 *     enforces backoff across all concurrent callTool() invocations so that
 *     multiple simultaneous tool calls do not each fire a reconnect attempt.
 *   - Rate limit on /messages: 100 per minute. Normal tool-call volume is
 *     well within this; no special handling needed.
 */

import {{ Client }} from '@modelcontextprotocol/sdk/client/index.js';
import {{ SSEClientTransport }} from '@modelcontextprotocol/sdk/client/sse.js';
import {{ readFileSync }} from 'fs';
import {{ homedir }} from 'os';
import {{ join }} from 'path';

const ENTITY_CODE = '{code}';
const SSE_URL     = '{sse_url}';
const CREDS_FILE  = join(homedir(), '.suitecrm-mcp', '{code}.json');
const TOOL_NAMES  = {tool_names};

// Backoff delays for reconnect attempts (ms). Caps at 60 s to stay within
// the gateway's 20-req/15-min rate limit on /sse.
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
let backoffIdx   = 0;
// Timestamp (ms) before which no reconnect attempt should be made.
// Shared across all concurrent callTool() calls so they all respect the same
// backoff window instead of each firing their own immediate reconnect.
let nextRetryAt  = 0;

export default {{
  id: 'suitecrm-{code}',
  name: 'SuiteCRM {label}',

  register(api) {{
    let creds;
    try {{
      creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
    }} catch {{
      process.stderr.write(
        `[SuiteCRM ${{ENTITY_CODE}}] Credentials not found — run: suitecrm-setup ${{ENTITY_CODE}}\\n`
      );
      return;
    }}

    if (!creds?.user || !creds?.pass) {{
      process.stderr.write(
        `[SuiteCRM ${{ENTITY_CODE}}] Incomplete credentials — run: suitecrm-setup ${{ENTITY_CODE}}\\n`
      );
      return;
    }}

    let client     = null;
    let ready      = false;
    let connecting = null;
    let authFailed = false; // permanent flag — stops all retries on 401

    // customFetch injects auth headers on every SSEClientTransport request
    // (both the GET /sse and the POST /messages calls).
    const customFetch = async (url, init) => {{
      const headers = new Headers(init?.headers);
      headers.set('x-crm-user', creds.user);
      headers.set('x-crm-pass', creds.pass);
      const resp = await fetch(url, {{ ...init, headers }});

      if (resp.status === 401) {{
        // Fail-fast auth: gateway rejected CRM credentials before opening the
        // SSE stream. This is not a transient error — do not retry.
        process.stderr.write(
          `[SuiteCRM ${{ENTITY_CODE}}] Auth rejected (HTTP 401) — run: suitecrm-setup ${{ENTITY_CODE}}\\n`
        );
        throw Object.assign(
          new Error('Gateway returned 401 — invalid CRM credentials'),
          {{ authFailed: true }}
        );
      }}

      if (resp.status === 429) {{
        const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
        process.stderr.write(
          `[SuiteCRM ${{ENTITY_CODE}}] Rate limited (HTTP 429) — retry after ${{retryAfter}}s\\n`
        );
        throw Object.assign(
          new Error(`Gateway rate limited — retry after ${{retryAfter}}s`),
          {{ rateLimited: true, retryAfter }}
        );
      }}

      return resp;
    }};

    function connect() {{
      // Permanent auth failure — nothing will fix this without re-running setup.
      if (authFailed) return Promise.resolve();

      // If a connect attempt is already in-flight, return its promise so all
      // concurrent callers wait on the same connection attempt.
      if (connecting) return connecting;

      // Enforce backoff: if we are still within the retry window, return a
      // promise that waits out the remaining delay then retries. This prevents
      // concurrent callTool() invocations from each firing an immediate reconnect.
      const wait = nextRetryAt - Date.now();
      if (wait > 0) {{
        return new Promise(resolve => setTimeout(() => resolve(connect()), wait));
      }}

      connecting = (async () => {{
        const transport = new SSEClientTransport(new URL(SSE_URL), {{
          eventSourceInit: {{ fetch: customFetch }},  // auth on GET /sse
          fetch: customFetch,                          // auth on POST /messages
        }});

        client = new Client(
          {{ name: `openclaw-suitecrm-${{ENTITY_CODE}}`, version: '1.0.0' }},
          {{ capabilities: {{}} }}
        );

        client.onerror = (err) => {{
          process.stderr.write(`[SuiteCRM ${{ENTITY_CODE}}] Connection error: ${{err.message}}\\n`);
          ready = false; client = null; connecting = null;
        }};

        await client.connect(transport);
        ready      = true;
        connecting = null;
        backoffIdx = 0;   // reset backoff on successful connect
        nextRetryAt = 0;
        process.stderr.write(`[SuiteCRM ${{ENTITY_CODE}}] Connected to gateway\\n`);
      }})().catch(err => {{
        connecting = null;
        ready      = false;
        client     = null;

        if (err.authFailed) {{
          authFailed = true; // stop all future retries
          return;
        }}

        const delay = err.rateLimited
          ? err.retryAfter * 1_000
          : BACKOFF_MS[Math.min(backoffIdx++, BACKOFF_MS.length - 1)];

        nextRetryAt = Date.now() + delay;
        process.stderr.write(
          `[SuiteCRM ${{ENTITY_CODE}}] Connect failed: ${{err.message}} — retry in ${{delay / 1000}}s\\n`
        );
      }});
      return connecting;
    }}

    async function callTool(toolName, toolArgs) {{
      if (!ready || !client) await connect();
      if (!client) {{
        throw new Error(`SuiteCRM ${{ENTITY_CODE}} gateway not available — check logs`);
      }}
      try {{
        return await client.callTool({{ name: toolName, arguments: toolArgs }});
      }} catch (err) {{
        const isConnErr =
          ['ECONNRESET', 'EPIPE', 'ERR_STREAM_WRITE_AFTER_END'].includes(err.code) ||
          err.message?.includes('closed') ||
          err.message?.includes('not connected');
        if (isConnErr) {{
          process.stderr.write(`[SuiteCRM ${{ENTITY_CODE}}] Reconnecting after: ${{err.message}}\\n`);
          ready = false; client = null; connecting = null;
          await connect();
          if (!client) throw new Error(`SuiteCRM ${{ENTITY_CODE}} unavailable after reconnect`);
          return await client.callTool({{ name: toolName, arguments: toolArgs }});
        }}
        throw err;
      }}
    }}

    for (const toolName of TOOL_NAMES) {{
      api.registerTool({{
        name: toolName,
        description: `SuiteCRM ${{ENTITY_CODE}} — ${{toolName.replace(`suitecrm_${{ENTITY_CODE}}_`, '')}}`,
        parameters: {{ type: 'object', properties: {{}}, additionalProperties: true }},
        async execute(_callId, params) {{
          const result = await callTool(toolName, params);
          const text = (result.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\\n');
          return {{ content: [{{ type: 'text', text: text || JSON.stringify(result) }}] }};
        }},
      }});
    }}

    // Lazy connect: first tool call triggers connect(). No background warmup
    // so the bridge does not consume a rate-limit slot at startup.
  }},
}};
"""


def _install_bridge_plugin(username, openclaw_dir, code, label, gateway_url, is_multi):
    plugin_id  = f"suitecrm-{code}"
    bridge_dir = f"{openclaw_dir}/extensions/{plugin_id}"
    os.makedirs(bridge_dir, exist_ok=True)
    # chown the directory before npm install runs as the target user,
    # otherwise npm cannot write node_modules into a root-owned directory.
    run(["chown", f"{username}:{username}", bridge_dir])

    write_file(f"{bridge_dir}/package.json", json.dumps({
        "name": plugin_id,
        "version": "1.0.0",
        "description": f"OpenClaw bridge — SuiteCRM {label}",
        "type": "module",
        "openclaw": {"extensions": ["./index.js"]},
        "dependencies": {"@modelcontextprotocol/sdk": "^1.29.0"},
    }, indent=2), owner=username)

    write_file(f"{bridge_dir}/openclaw.plugin.json", json.dumps({
        "id": plugin_id,
        "name": f"SuiteCRM {label}",
        "description": f"Routes {label} tool calls to the remote SuiteCRM MCP gateway via SSE",
        "version": "1.0.0",
        "configSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "command": {"type": "string"},
                "args":    {"type": "array",  "items": {"type": "string"}},
                "env":     {"type": "object", "additionalProperties": {"type": "string"}},
            },
        },
    }, indent=2), owner=username)

    write_file(
        f"{bridge_dir}/index.js",
        _make_bridge_js(code, label, gateway_url, is_multi),
        owner=username,
    )

    npm_path = shutil.which("npm") or "/usr/bin/npm"
    run(["runuser", "-u", username, "--", npm_path, "install", "--silent"], cwd=bridge_dir)
    # chown -R after npm install so that any files written by a previous root-owned
    # install (e.g. on --update) are corrected. The pre-install chown above only
    # covers the directory itself, not existing node_modules contents.
    run(["chown", "-R", f"{username}:{username}", bridge_dir])
    ok(f"  Plugin suitecrm-{code} installed for {username}")


def _patch_openclaw_config(username, openclaw_dir, entities):
    config_path = f"{openclaw_dir}/openclaw.json"
    if not os.path.exists(config_path):
        warn(f"  openclaw.json not found for {username} — skipping config patch")
        return
    try:
        with open(config_path) as f: config = json.load(f)
    except Exception as e:
        warn(f"  Could not parse openclaw.json for {username}: {e}"); return

    plugins = config.setdefault("plugins", {})
    allow   = plugins.setdefault("allow", [])
    entries = plugins.setdefault("entries", {})
    added = 0
    for code in entities:
        pid = f"suitecrm-{code}"
        if pid not in allow:
            allow.append(pid); added += 1
        entries[pid] = {"enabled": True}

    ok(f"  Registered {added} new plugin(s) in openclaw.json" if added
       else "  Plugins already registered in openclaw.json")

    tools_cfg = config.setdefault("tools", {})
    if tools_cfg.get("profile") != "full":
        tools_cfg["profile"] = "full"
        ok("  tools.profile set to 'full'")

    with open(config_path, "w") as f: json.dump(config, f, indent=2)
    run(["chown", f"{username}:{username}", config_path])
    run(["chmod", "600", config_path])


def install_for_user(username, entities, gateway_url, is_multi):
    home         = f"/home/{username}"
    openclaw_dir = f"{home}/.openclaw"
    creds_dir    = f"{home}/.suitecrm-mcp"

    if not os.path.isdir(home):
        warn(f"Home directory not found for {username} — skipping"); return
    if not os.path.isdir(openclaw_dir):
        warn(f"OpenClaw not installed for {username} (no {openclaw_dir}) — skipping"); return

    # Generic credential directory — not OpenClaw-specific so it survives
    # if the user switches agent runtimes.
    os.makedirs(creds_dir, exist_ok=True)
    run(["chown", f"{username}:{username}", creds_dir])
    run(["chmod", "700", creds_dir])

    for code, label in entities.items():
        _install_bridge_plugin(username, openclaw_dir, code, label, gateway_url, is_multi)

    _patch_openclaw_config(username, openclaw_dir, entities)
    ok(f"Bridge installed for {username}")


def install_setup_script(entities, gateway_url, is_multi):
    """Install /usr/local/bin/suitecrm-setup — credential manager CLI."""
    entity_cases = "\n".join(
        f'    {code}) LABEL="{label}" ;;' for code, label in entities.items()
    )
    valid_codes  = " ".join(entities.keys())
    status_block = "\n".join(
        f'  show_entity_status "{code}" "{label}"' for code, label in entities.items()
    )
    test_url_expr = '"$GATEWAY_URL/$CODE/test"' if is_multi else '"$GATEWAY_URL/test"'

    script = f"""#!/usr/bin/env bash
# suitecrm-setup — configure CRM credentials for the SuiteCRM MCP bridge
# Generated by install-bridge.py
set -euo pipefail

GATEWAY_URL="{gateway_url}"
CREDS_DIR="$HOME/.suitecrm-mcp"
RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; CYAN='\\033[0;36m'; NC='\\033[0m'
info() {{ echo -e "${{CYAN}}[INFO]${{NC}} $*"; }}
ok()   {{ echo -e "${{GREEN}}[OK]${{NC}} $*"; }}
warn() {{ echo -e "${{YELLOW}}[WARN]${{NC}} $*"; }}
err()  {{ echo -e "${{RED}}[ERROR]${{NC}} $*" >&2; exit 1; }}

show_entity_status() {{
  local CODE="$1" LABEL="$2" CREDS="$CREDS_DIR/$1.json"
  if [ -f "$CREDS" ]; then
    local USER
    USER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('user','?'))" "$CREDS" 2>/dev/null || echo "?")
    ok "  $CODE ($LABEL) — configured as $USER"
  else
    warn "  $CODE ($LABEL) — not configured [run: suitecrm-setup $CODE]"
  fi
}}

show_status() {{
  echo; info "Gateway: $GATEWAY_URL"; echo
{status_block}
  echo
}}

setup_entity() {{
  local CODE="$1" LABEL=""
  case "$CODE" in
{entity_cases}
    *) err "Unknown entity: $CODE. Valid: {valid_codes}" ;;
  esac
  echo; info "Configuring $LABEL ($CODE)"; echo
  read -rp "  CRM username: " CRM_USER
  read -rsp "  CRM password: " CRM_PASS; echo
  [ -z "$CRM_USER" ] && err "Username cannot be empty"
  [ -z "$CRM_PASS" ] && err "Password cannot be empty"

  info "Testing credentials against gateway..."
  local TEST_URL={test_url_expr}
  local RESPONSE HTTP_CODE BODY
  RESPONSE=$(curl -s -w "\\n%{{http_code}}" -m 15 \\
    -H "X-CRM-User: $CRM_USER" -H "X-CRM-Pass: $CRM_PASS" \\
    "$TEST_URL" 2>&1) || err "Could not reach gateway at $GATEWAY_URL"
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  case "$HTTP_CODE" in
    200) ok "CRM credentials verified" ;;
    400) err "Bad request — check gateway URL and entity code" ;;
    401) err "CRM login failed — check username and password: $BODY" ;;
    429) err "Gateway rate limited — wait 15 minutes and try again" ;;
    *)   err "Gateway error (HTTP $HTTP_CODE): $BODY" ;;
  esac

  mkdir -p "$CREDS_DIR"; chmod 700 "$CREDS_DIR"
  # Write credentials via Python to avoid shell quoting issues with special chars.
  CRM_USER="$CRM_USER" CRM_PASS="$CRM_PASS" python3 -c "
import json, os, sys
path = os.path.join(os.path.expanduser('~'), '.suitecrm-mcp', sys.argv[1] + '.json')
with open(path, 'w') as fh:
    json.dump({{'user': os.environ['CRM_USER'], 'pass': os.environ['CRM_PASS']}}, fh, indent=2)
os.chmod(path, 0o600)
" "$CODE"
  unset CRM_USER CRM_PASS
  ok "Credentials saved to ~/.suitecrm-mcp/$CODE.json"; echo
  warn "Restart OpenClaw to apply: sudo systemctl restart openclaw-$(whoami)"; echo
}}

remove_entity() {{
  local CODE="$1" CREDS="$CREDS_DIR/$CODE.json"
  if [ -f "$CREDS" ]; then
    rm -f "$CREDS"; ok "Removed credentials for $CODE"
  else
    warn "No credentials found for $CODE"
  fi
}}

CODE="${{1:-}}" SUBCMD="${{2:-}}"
case "$CODE" in
  ""|--status) show_status ;;
  --help|-h)
    echo "Usage: suitecrm-setup [code] [--remove]"
    echo "Valid codes: {valid_codes}"
    ;;
  *) [ "$SUBCMD" = "--remove" ] && remove_entity "$CODE" || setup_entity "$CODE" ;;
esac
"""
    write_file(SETUP_SCRIPT, script, mode="755")
    ok(f"suitecrm-setup installed: {SETUP_SCRIPT}")


def remove_for_user(username, entities):
    home         = f"/home/{username}"
    openclaw_dir = f"{home}/.openclaw"
    creds_dir    = f"{home}/.suitecrm-mcp"

    info(f"Removing bridge from {username}...")
    for code in entities:
        bridge_dir = f"{openclaw_dir}/extensions/suitecrm-{code}"
        if os.path.isdir(bridge_dir):
            shutil.rmtree(bridge_dir)
            ok(f"  Removed plugin: suitecrm-{code}")
        creds = f"{creds_dir}/{code}.json"
        if os.path.exists(creds):
            os.remove(creds)
            ok(f"  Removed credentials: {code}.json")

    config_path = f"{openclaw_dir}/openclaw.json"
    if os.path.exists(config_path):
        try:
            with open(config_path) as f: config = json.load(f)
            plugins = config.get("plugins", {})
            allow   = plugins.get("allow", [])
            entries = plugins.get("entries", {})
            for code in entities:
                pid = f"suitecrm-{code}"
                if pid in allow: allow.remove(pid)
                entries.pop(pid, None)
            with open(config_path, "w") as f: json.dump(config, f, indent=2)
            run(["chown", f"{username}:{username}", config_path])
            run(["chmod", "600", config_path])
            ok("  Updated openclaw.json")
        except Exception as e:
            warn(f"  Could not patch openclaw.json: {e}")

    warn(f"Restart OpenClaw: sudo systemctl restart openclaw-{username}")


def main():
    parser = argparse.ArgumentParser(
        description="SuiteCRM MCP Bridge Installer for OpenClaw",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--gateway",  required=True,
                        help="Gateway base URL, e.g. http://GATEWAY_HOST:8080 (no path)")
    parser.add_argument("--entities", metavar="FILE",
                        help="Path to entities.json (multi-entity mode)")
    parser.add_argument("--code",     help="Entity code for single-entity mode")
    parser.add_argument("--label",    help="Entity label for single-entity mode (default: code)")
    parser.add_argument("--update",   action="store_true",
                        help="Reinstall bridge plugins without wiping credentials")
    parser.add_argument("--remove",   nargs="+", metavar="USER",
                        help="Remove bridge from user(s)")
    parser.add_argument("users",      nargs="*",
                        help="Target users (default: all users in /home)")
    args = parser.parse_args()

    if os.geteuid() != 0: error("Run as root (sudo)")

    gateway_url = validate_gateway_url(args.gateway)
    entities    = load_entities(args)
    is_multi    = bool(args.entities)

    if args.remove:
        for u in args.remove: validate_username(u)
        print(); warn(f"Removing bridge from: {', '.join(args.remove)}")
        if input("  Type 'yes' to confirm: ").strip().lower() != "yes":
            info("Aborted."); sys.exit(0)
        for username in args.remove:
            remove_for_user(username, entities)
        print(); ok("Done."); sys.exit(0)

    print()
    info("=" * 60)
    info("SUITECRM MCP BRIDGE INSTALLER")
    info("=" * 60)
    print()

    info("Checking Node.js..."); check_node(); print()

    if args.users:
        for u in args.users: validate_username(u)
        users = args.users
    else:
        users = sorted(u for u in os.listdir("/home") if os.path.isdir(f"/home/{u}"))
    if not users: error("No users found in /home")

    info(f"Gateway  : {gateway_url}")
    info(f"Mode     : {'multi-entity' if is_multi else 'single-entity'}")
    info(f"Entities : {', '.join(f'{c} ({l})' for c, l in entities.items())}")
    info(f"Users    : {', '.join(users)}")
    print()

    info("Installing suitecrm-setup CLI...")
    install_setup_script(entities, gateway_url, is_multi)
    print()

    for username in users:
        info("=" * 50)
        info(f"Installing for: {username}")
        info("=" * 50)
        install_for_user(username, entities, gateway_url, is_multi)
        print()

    print()
    info("=" * 60)
    ok("INSTALL COMPLETE")
    info("=" * 60)
    print()
    info("Next — configure credentials for each user:")
    for code in entities:
        print(f"  suitecrm-setup {code}")
    print()
    info("Then restart OpenClaw:")
    print("  sudo systemctl restart openclaw-USERNAME")
    print()


if __name__ == "__main__":
    main()
