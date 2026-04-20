#!/usr/bin/env python3
"""
SuiteCRM MCP Bridge Installer for OpenClaw
==========================================
Runs on the OpenClaw machine. Installs per-user bridge plugins that
connect OpenClaw to a remote suitecrm-mcp gateway via SSE.

Compatible with suitecrm-mcp gateway v3.0+.

Auth flow (no CLI required on the OpenClaw machine):
  1. Bridge plugin starts and checks ~/.suitecrm-mcp/gateway.token.
  2. If no token, it prints the auth URL and polls the gateway in the background.
  3. User visits the auth URL in a browser, logs in via the identity provider.
  4. Gateway delivers a token to the poll endpoint; bridge saves it and connects.
  5. Future restarts use the saved token automatically.

Usage:
  # Single entity
  sudo python3 install-bridge.py --gateway https://mcp.yourcompany.com --code mycrm --label "My CRM"

  # Multi entity (reads entities.json -- same format as install.py)
  sudo python3 install-bridge.py --gateway https://mcp.yourcompany.com --entities entities.json

  # Target specific users (default: all users in /home with ~/.openclaw/openclaw.json)
  sudo python3 install-bridge.py --gateway ... --entities entities.json user1 user2

  # Remove bridge from users
  sudo python3 install-bridge.py --remove user1 user2 --gateway ... --entities entities.json

  # Reinstall bridge plugins (preserves token)
  sudo python3 install-bridge.py --update --gateway ... --entities entities.json
"""

import os, sys, subprocess, json, argparse, re, shutil
from pathlib import Path
from urllib.parse import urlparse

RED = "\033[0;31m"; GREEN = "\033[0;32m"; YELLOW = "\033[1;33m"; CYAN = "\033[0;36m"; NC = "\033[0m"
def info(m): print(f"{CYAN}[INFO]{NC} {m}")
def ok(m):   print(f"{GREEN}[OK]{NC} {m}")
def warn(m): print(f"{YELLOW}[WARN]{NC} {m}")
def error(m): print(f"{RED}[ERROR]{NC} {m}"); sys.exit(1)

SAFE_CODE_RE  = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$')
SAFE_LABEL_RE = re.compile(r'^[a-zA-Z0-9 _.,()\-]+$')
SAFE_USER_RE  = re.compile(r'^[a-zA-Z0-9_-]+$')
TOOL_SUFFIXES = [
    "search", "search_text", "get", "create", "update", "delete",
    "count", "get_relationships", "link_records", "unlink_records",
    "get_module_fields", "list_modules", "server_info",
]

def validate_code(c):
    if not SAFE_CODE_RE.match(c):
        error(f"Invalid entity code: {c!r} -- use letters, digits, hyphens, underscores only")

def validate_label(l):
    if not SAFE_LABEL_RE.match(l):
        error(f"Invalid entity label: {l!r} -- use letters, digits, spaces, and basic punctuation only")

def validate_username(u):
    if not SAFE_USER_RE.match(u):
        error(f"Invalid username: {u!r} -- use letters, digits, hyphens, underscores only")

def validate_gateway_url(url):
    url = url.rstrip('/')
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        error(f"Invalid gateway URL: {url!r} -- must start with http:// or https://")
    if not parsed.netloc:
        error(f"Invalid gateway URL: {url!r} -- missing host")
    if parsed.path not in ('', '/'):
        error(
            f"Invalid gateway URL: {url!r} -- must be a bare origin with no path "
            f"(e.g. https://mcp.yourcompany.com, not https://mcp.yourcompany.com/some/path)"
        )
    return url

def suitecrm_plugin_ids(entities):
    return [f"suitecrm-{code}" for code in entities]

def suitecrm_tool_names(entities):
    return [f"suitecrm_{code}_{suffix}" for code in entities for suffix in TOOL_SUFFIXES]

def normalize_token(value):
    return value.strip().lower()

def run(cmd, check=True, capture=False, cwd=None):
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
        error("Node.js not found. Install OpenClaw first -- it requires Node.js.")
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


def list_candidate_users():
    candidates = []
    for username in sorted(os.listdir("/home")):
        if not SAFE_USER_RE.match(username):
            continue
        home = f"/home/{username}"
        config_path = f"{home}/.openclaw/openclaw.json"
        if os.path.isdir(home) and os.path.exists(config_path):
            candidates.append(username)
    return candidates


def load_openclaw_config_for_user(username):
    openclaw_dir = f"/home/{username}/.openclaw"
    config_path = f"{openclaw_dir}/openclaw.json"
    if not os.path.exists(config_path):
        return openclaw_dir, config_path, None
    try:
        with open(config_path) as f:
            return openclaw_dir, config_path, json.load(f)
    except Exception as e:
        warn(f"  Could not parse openclaw.json for {username}: {e}")
        return openclaw_dir, config_path, None


def save_openclaw_config(username, config_path, config):
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    run(["chown", f"{username}:{username}", config_path])
    run(["chmod", "600", config_path])


def discover_agents(config):
    agents = []
    raw_agents = ((config or {}).get("agents") or {}).get("list") or []
    if not isinstance(raw_agents, list):
        return agents

    for idx, agent in enumerate(raw_agents):
        if not isinstance(agent, dict):
            continue
        agent_id = str(agent.get("id") or "").strip()
        agent_name = str(agent.get("name") or "").strip()
        primary = agent_id or agent_name
        if not primary:
            primary = f"agent-{idx + 1}"
        aliases = {normalize_token(primary)}
        if agent_id:
            aliases.add(normalize_token(agent_id))
        if agent_name:
            aliases.add(normalize_token(agent_name))
        agents.append({
            "index": idx,
            "id": agent_id,
            "name": agent_name,
            "primary": primary,
            "aliases": aliases,
        })
    return agents


def prompt_choice(prompt, allow_empty=False):
    if not sys.stdin.isatty():
        error(f"{prompt} (interactive input required)")
    while True:
        value = input(prompt).strip()
        if value or allow_empty:
            return value


def prompt_for_users(candidates):
    if len(candidates) == 1:
        return candidates

    print()
    info("Detected OpenClaw users:")
    for username in candidates:
        print(f"  - {username}")
    print()
    while True:
        raw = prompt_choice("Select users to install for ('all' or comma-separated usernames): ")
        if normalize_token(raw) == "all":
            return candidates
        chosen = [u.strip() for u in raw.split(",") if u.strip()]
        invalid = [u for u in chosen if u not in candidates]
        if not chosen:
            warn("Please select at least one user.")
            continue
        if invalid:
            warn(f"Unknown user(s): {', '.join(invalid)}")
            continue
        return list(dict.fromkeys(chosen))


def resolve_attach_arg(raw_attach):
    attach = (raw_attach or "").strip()
    if not attach:
        return None
    if normalize_token(attach) == "all":
        return {"mode": "all", "requested": []}
    requested = [item.strip() for item in attach.split(",") if item.strip()]
    if not requested:
        error("--attach requires 'all' or a comma-separated list of agent ids/names")
    return {"mode": "selected", "requested": requested}


def resolve_agent_selection(username, config, attach_spec):
    agents = discover_agents(config)
    if not agents:
        info(f"  No configured agents found for {username} -- installing plugin only")
        return {"mode": "plugin-only", "agents": [], "labels": []}

    if attach_spec:
        if attach_spec["mode"] == "all":
            return {
                "mode": "all",
                "agents": agents,
                "labels": [agent["primary"] for agent in agents],
            }

        alias_map = {}
        for agent in agents:
            for alias in agent["aliases"]:
                alias_map.setdefault(alias, []).append(agent)

        selected = []
        invalid = []
        ambiguous = []
        for token in attach_spec["requested"]:
            matches = alias_map.get(normalize_token(token), [])
            if not matches:
                invalid.append(token)
                continue
            if len(matches) > 1:
                ambiguous.append(token)
                continue
            selected.append(matches[0])

        if invalid:
            valid = ", ".join(agent["primary"] for agent in agents)
            warn(f"  Unknown agent(s) for {username}: {', '.join(invalid)}. Valid: {valid} -- installing plugin only")
            return {"mode": "plugin-only", "agents": [], "labels": []}
        if ambiguous:
            error(f"Ambiguous agent identifier(s) for {username}: {', '.join(ambiguous)}")

        deduped = []
        seen = set()
        for agent in selected:
            key = agent["index"]
            if key not in seen:
                seen.add(key)
                deduped.append(agent)

        return {
            "mode": "selected",
            "agents": deduped,
            "labels": [agent["primary"] for agent in deduped],
        }

    if len(agents) == 1:
        agent = agents[0]
        info(f"  One configured agent found for {username} -- attaching to {agent['primary']}")
        return {"mode": "selected", "agents": [agent], "labels": [agent["primary"]]}

    print()
    info(f"Configured agents for {username}:")
    for agent in agents:
        label = agent["primary"]
        extras = []
        if agent["id"] and agent["id"] != label:
            extras.append(f"id={agent['id']}")
        if agent["name"] and agent["name"] != label:
            extras.append(f"name={agent['name']}")
        suffix = f" ({', '.join(extras)})" if extras else ""
        print(f"  - {label}{suffix}")
    print()

    while True:
        raw = prompt_choice(
            f"Attach SuiteCRM bridge for {username} to ('all' or comma-separated agent ids/names): "
        )
        if normalize_token(raw) == "all":
            return {
                "mode": "all",
                "agents": agents,
                "labels": [agent["primary"] for agent in agents],
            }
        requested = [item.strip() for item in raw.split(",") if item.strip()]
        if not requested:
            warn("Please choose 'all' or at least one agent.")
            continue
        return resolve_agent_selection(username, config, {"mode": "selected", "requested": requested})


def _make_bridge_js(code, label, gateway_url, is_multi):
    """Generate the OpenClaw plugin JS for one entity (v3.0 OAuth token auth)."""
    tool_names = json.dumps(
        [f"suitecrm_{code}_{s}" for s in TOOL_SUFFIXES] if is_multi
        else [f"suitecrm_{s}" for s in TOOL_SUFFIXES]
    )
    sse_url  = f"{gateway_url}/{code}/sse" if is_multi else f"{gateway_url}/sse"
    auth_url = f"{gateway_url}/auth/login"

    return f"""/**
 * SuiteCRM Bridge Plugin for OpenClaw
 * Entity : {label} ({code})
 * Gateway: {gateway_url}
 *
 * Compatible with suitecrm-mcp gateway v3.0+
 *
 * Auth flow:
 *   1. Reads ~/.suitecrm-mcp/gateway.token for a gateway-issued API key.
 *   2. If no token found, prints the auth URL and polls the gateway until
 *      the user authenticates in their browser (no CLI needed).
 *   3. All gateway requests carry: Authorization: Bearer <token>
 *   4. On 401, clears the saved token and restarts the auth flow.
 */

import {{ Client }} from '@modelcontextprotocol/sdk/client/index.js';
import {{ SSEClientTransport }} from '@modelcontextprotocol/sdk/client/sse.js';
import {{ readFileSync, writeFileSync, unlinkSync, mkdirSync }} from 'fs';
import {{ homedir, userInfo }} from 'os';
import {{ join }} from 'path';

const ENTITY_CODE = '{code}';
const SSE_URL     = '{sse_url}';
const AUTH_URL    = '{auth_url}';
const LINUX_USER  = userInfo().username;
const STATUS_URL  = `{gateway_url}/auth/status/${{LINUX_USER}}`;
const TOKEN_FILE  = join(homedir(), '.suitecrm-mcp', 'gateway.token');
const TOKEN_DIR   = join(homedir(), '.suitecrm-mcp');
const TOOL_NAMES  = {tool_names};

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
let backoffIdx  = 0;
let nextRetryAt = 0;

let token            = null;
let authTokenPromise = null; // in-flight poll promise (shared across callers)

function loadToken() {{
  try {{
    const raw = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (raw) {{ token = raw; return true; }}
  }} catch {{}}
  return false;
}}

function saveToken(t) {{
  mkdirSync(TOKEN_DIR, {{ recursive: true, mode: 0o700 }});
  writeFileSync(TOKEN_FILE, t, {{ mode: 0o600 }});
  token = t;
}}

function clearToken() {{
  token = null;
  try {{ unlinkSync(TOKEN_FILE); }} catch {{}}
}}

function pollForToken() {{
  if (authTokenPromise) return authTokenPromise;

  process.stderr.write(`[SuiteCRM ${{ENTITY_CODE}}] No token found.\\n`);
  process.stderr.write(`[SuiteCRM ${{ENTITY_CODE}}] Authenticate at: ${{AUTH_URL}}\\n`);

  const INTERVAL_MS = 3_000;
  const TIMEOUT_MS  = 15 * 60 * 1_000; // 15 min matches gateway pending-token TTL
  const start       = Date.now();

  authTokenPromise = new Promise(resolve => {{
    const tick = async () => {{
      if (Date.now() - start > TIMEOUT_MS) {{
        process.stderr.write(
          `[SuiteCRM ${{ENTITY_CODE}}] Auth timed out. Restart OpenClaw and authenticate again.\\n`
        );
        authTokenPromise = null;
        return resolve(false);
      }}
      try {{
        const resp = await fetch(STATUS_URL, {{ signal: AbortSignal.timeout(10_000) }});
        if (resp.ok) {{
          const data = await resp.json();
          if (data.api_key) {{
            saveToken(data.api_key);
            process.stderr.write(`[SuiteCRM ${{ENTITY_CODE}}] Token received.\\n`);
            authTokenPromise = null;
            return resolve(true);
          }}
        }}
      }} catch {{}}
      setTimeout(tick, INTERVAL_MS);
    }};
    setTimeout(tick, INTERVAL_MS);
  }});

  return authTokenPromise;
}}

async function requireToken() {{
  if (token) return true;
  if (loadToken()) return true;
  return pollForToken();
}}

export default {{
  id: 'suitecrm-{code}',
  name: 'SuiteCRM {label}',

  register(api) {{
    let client     = null;
    let ready      = false;
    let connecting = null;

    const customFetch = async (url, init) => {{
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${{token}}`);
      const resp = await fetch(url, {{ ...init, headers }});

      if (resp.status === 401) {{
        process.stderr.write(
          `[SuiteCRM ${{ENTITY_CODE}}] Token rejected (HTTP 401) -- clearing token, re-auth required\\n`
        );
        clearToken();
        throw Object.assign(
          new Error('Gateway returned 401 -- token expired or revoked'),
          {{ needsReauth: true }}
        );
      }}

      if (resp.status === 429) {{
        const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
        process.stderr.write(
          `[SuiteCRM ${{ENTITY_CODE}}] Rate limited (HTTP 429) -- retry after ${{retryAfter}}s\\n`
        );
        throw Object.assign(
          new Error(`Gateway rate limited -- retry after ${{retryAfter}}s`),
          {{ rateLimited: true, retryAfter }}
        );
      }}

      return resp;
    }};

    function connect() {{
      if (connecting) return connecting;
      const wait = nextRetryAt - Date.now();
      if (wait > 0) return new Promise(res => setTimeout(() => res(connect()), wait));

      connecting = (async () => {{
        const hasToken = await requireToken();
        if (!hasToken) {{ connecting = null; return; }}

        const transport = new SSEClientTransport(new URL(SSE_URL), {{
          eventSourceInit: {{ fetch: customFetch }},
          fetch: customFetch,
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
        ready       = true;
        connecting  = null;
        backoffIdx  = 0;
        nextRetryAt = 0;
        process.stderr.write(`[SuiteCRM ${{ENTITY_CODE}}] Connected to gateway\\n`);
      }})().catch(err => {{
        connecting = null;
        ready      = false;
        client     = null;

        if (err.needsReauth) {{
          // Restart auth flow, then reconnect once token arrives
          pollForToken().then(ok => {{ if (ok) {{ backoffIdx = 0; nextRetryAt = 0; connect(); }} }});
          return;
        }}

        const delay = err.rateLimited
          ? err.retryAfter * 1_000
          : BACKOFF_MS[Math.min(backoffIdx++, BACKOFF_MS.length - 1)];
        nextRetryAt = Date.now() + delay;
        process.stderr.write(
          `[SuiteCRM ${{ENTITY_CODE}}] Connect failed: ${{err.message}} -- retry in ${{delay / 1000}}s\\n`
        );
      }});
      return connecting;
    }}

    async function callTool(toolName, toolArgs) {{
      if (!ready || !client) await connect();
      if (!client) throw new Error(`SuiteCRM ${{ENTITY_CODE}} gateway not available -- check logs`);
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
        description: `SuiteCRM ${{ENTITY_CODE}} -- ${{toolName.replace(`suitecrm_${{ENTITY_CODE}}_`, '')}}`,
        optional: true,
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

    // Trigger connection at startup so the auth prompt appears immediately.
    connect().catch(() => {{}});
  }},
}};
"""


def _install_bridge_plugin(username, openclaw_dir, code, label, gateway_url, is_multi):
    plugin_id  = f"suitecrm-{code}"
    bridge_dir = f"{openclaw_dir}/extensions/{plugin_id}"
    os.makedirs(bridge_dir, exist_ok=True)
    run(["chown", f"{username}:{username}", bridge_dir])

    write_file(f"{bridge_dir}/package.json", json.dumps({
        "name": plugin_id,
        "version": "1.0.0",
        "description": f"OpenClaw bridge -- SuiteCRM {label}",
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
    run(["chown", "-R", f"{username}:{username}", bridge_dir])
    ok(f"  Plugin suitecrm-{code} installed for {username}")


def _merge_unique(values, additions):
    for item in additions:
        if item not in values:
            values.append(item)


def _remove_values(values, removals):
    removal_set = set(removals)
    return [item for item in values if item not in removal_set]


def _patch_openclaw_config(username, openclaw_dir, entities, agent_selection):
    config_path = f"{openclaw_dir}/openclaw.json"
    if not os.path.exists(config_path):
        warn(f"  openclaw.json not found for {username} -- skipping config patch")
        return
    try:
        with open(config_path) as f:
            config = json.load(f)
    except Exception as e:
        warn(f"  Could not parse openclaw.json for {username}: {e}")
        return

    plugin_ids = suitecrm_plugin_ids(entities)
    tool_names = suitecrm_tool_names(entities)

    plugins = config.setdefault("plugins", {})
    plugin_allow = plugins.setdefault("allow", [])
    entries = plugins.setdefault("entries", {})
    added = 0
    for pid in plugin_ids:
        if pid not in plugin_allow:
            plugin_allow.append(pid)
            added += 1
        entries.setdefault(pid, {}).update({"enabled": True})

    ok(f"  Registered {added} new plugin(s) in openclaw.json" if added
       else "  Plugins already registered in openclaw.json")

    tools_cfg = config.setdefault("tools", {})
    if tools_cfg.get("profile") != "full":
        tools_cfg["profile"] = "full"
        ok("  tools.profile set to 'full'")
    global_allow = tools_cfg.setdefault("allow", [])

    agents_cfg = config.setdefault("agents", {})
    agent_list = agents_cfg.setdefault("list", [])
    selected_indexes = {agent["index"] for agent in agent_selection["agents"]}

    if agent_selection["mode"] == "all":
        if global_allow:
            _merge_unique(global_allow, plugin_ids)
        for agent in agent_list:
            if not isinstance(agent, dict):
                continue
            agent_tools = agent.setdefault("tools", {})
            allow = agent_tools.setdefault("allow", [])
            if allow:
                _merge_unique(allow, plugin_ids)
        ok("  Bridge tools enabled for all agents")
    elif agent_selection["mode"] == "selected":
        for idx, agent in enumerate(agent_list):
            if not isinstance(agent, dict):
                continue
            agent_tools = agent.setdefault("tools", {})
            allow = agent_tools.setdefault("allow", [])
            if idx in selected_indexes:
                if allow:
                    _merge_unique(allow, plugin_ids)
            else:
                agent_tools["allow"] = _remove_values(allow, plugin_ids + tool_names)
        ok(f"  Bridge tools scoped to agents: {', '.join(agent_selection['labels'])}")
    else:
        ok("  Plugin registered without agent-specific attachment")

    save_openclaw_config(username, config_path, config)


def install_for_user(username, entities, gateway_url, is_multi, agent_selection):
    home         = f"/home/{username}"
    openclaw_dir = f"{home}/.openclaw"
    token_dir    = f"{home}/.suitecrm-mcp"

    if not os.path.isdir(home):
        warn(f"Home directory not found for {username} -- skipping"); return
    if not os.path.isdir(openclaw_dir):
        warn(f"OpenClaw not installed for {username} (no {openclaw_dir}) -- skipping"); return

    # Token directory: bridge reads/writes ~/.suitecrm-mcp/gateway.token
    os.makedirs(token_dir, exist_ok=True)
    run(["chown", f"{username}:{username}", token_dir])
    run(["chmod", "700", token_dir])

    for code, label in entities.items():
        _install_bridge_plugin(username, openclaw_dir, code, label, gateway_url, is_multi)

    _patch_openclaw_config(username, openclaw_dir, entities, agent_selection)
    ok(f"Bridge installed for {username}")


def remove_for_user(username, entities):
    home         = f"/home/{username}"
    openclaw_dir = f"{home}/.openclaw"
    token_dir    = f"{home}/.suitecrm-mcp"

    info(f"Removing bridge from {username}...")
    for code in entities:
        bridge_dir = f"{openclaw_dir}/extensions/suitecrm-{code}"
        if os.path.isdir(bridge_dir):
            shutil.rmtree(bridge_dir)
            ok(f"  Removed plugin: suitecrm-{code}")

    # Only remove the token file if all entities are being removed
    token_file = f"{token_dir}/gateway.token"
    if os.path.exists(token_file):
        os.remove(token_file)
        ok(f"  Removed gateway token")

    config_path = f"{openclaw_dir}/openclaw.json"
    if os.path.exists(config_path):
        try:
            with open(config_path) as f: config = json.load(f)
            plugin_ids = suitecrm_plugin_ids(entities)
            tool_names = suitecrm_tool_names(entities)
            plugins = config.get("plugins", {})
            allow   = plugins.get("allow", [])
            entries = plugins.get("entries", {})
            plugins["allow"] = _remove_values(allow, plugin_ids + tool_names)
            for pid in plugin_ids:
                entries.pop(pid, None)

            tools_cfg = config.get("tools", {})
            if isinstance(tools_cfg.get("allow"), list):
                tools_cfg["allow"] = _remove_values(tools_cfg["allow"], plugin_ids + tool_names)

            agent_list = ((config.get("agents") or {}).get("list")) or []
            for agent in agent_list:
                if not isinstance(agent, dict):
                    continue
                agent_tools = agent.get("tools")
                if not isinstance(agent_tools, dict):
                    continue
                if isinstance(agent_tools.get("allow"), list):
                    agent_tools["allow"] = _remove_values(agent_tools["allow"], plugin_ids + tool_names)

            save_openclaw_config(username, config_path, config)
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
                        help="Gateway base URL, e.g. https://mcp.yourcompany.com (no path)")
    parser.add_argument("--entities", metavar="FILE",
                        help="Path to entities.json (multi-entity mode)")
    parser.add_argument("--code",     help="Entity code for single-entity mode")
    parser.add_argument("--label",    help="Entity label for single-entity mode (default: code)")
    parser.add_argument("--update",   action="store_true",
                        help="Reinstall bridge plugins without wiping the saved token")
    parser.add_argument("--attach",
                        help="Attach bridge to 'all' agents or a comma-separated list of agent ids/names")
    parser.add_argument("--remove",   nargs="+", metavar="USER",
                        help="Remove bridge from user(s)")
    parser.add_argument("users",      nargs="*",
                        help="Target users (default: all users in /home)")
    args = parser.parse_args()

    if os.geteuid() != 0: error("Run as root (sudo)")

    gateway_url = validate_gateway_url(args.gateway)
    entities    = load_entities(args)
    is_multi    = bool(args.entities)
    attach_spec = resolve_attach_arg(args.attach)

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
        for u in args.users:
            validate_username(u)
        users = list(dict.fromkeys(args.users))
    else:
        users = list_candidate_users()
        if not users:
            error("No OpenClaw users found with ~/.openclaw/openclaw.json under /home")
        users = prompt_for_users(users)
    if not users:
        error("No target users selected")

    selections = {}
    for username in users:
        _, _, config = load_openclaw_config_for_user(username)
        selections[username] = resolve_agent_selection(username, config, attach_spec)

    info(f"Gateway  : {gateway_url}")
    info(f"Mode     : {'multi-entity' if is_multi else 'single-entity'}")
    info(f"Entities : {', '.join(f'{c} ({l})' for c, l in entities.items())}")
    info(f"Users    : {', '.join(users)}")
    for username in users:
        selection = selections[username]
        if selection["mode"] == "all":
            info(f"Attach   : {username} -> all agents")
        elif selection["mode"] == "selected":
            info(f"Attach   : {username} -> {', '.join(selection['labels'])}")
        else:
            info(f"Attach   : {username} -> plugin only")
    print()

    for username in users:
        info("=" * 50)
        info(f"Installing for: {username}")
        info("=" * 50)
        install_for_user(username, entities, gateway_url, is_multi, selections[username])
        print()

    print()
    info("=" * 60)
    ok("INSTALL COMPLETE")
    info("=" * 60)
    print()
    info("Next steps:")
    print(f"  1. Restart OpenClaw for each user:")
    print(f"     sudo systemctl restart openclaw-USERNAME")
    print()
    print(f"  2. Each user authenticates once by visiting:")
    print(f"     {gateway_url}/auth/login")
    print()
    print(f"  The bridge polls the gateway automatically and connects")
    print(f"  as soon as the user completes login -- no CLI needed.")
    print()


if __name__ == "__main__":
    main()
