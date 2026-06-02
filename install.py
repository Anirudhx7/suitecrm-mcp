#!/usr/bin/env python3
"""
SuiteCRM MCP Gateway - Unified Installer
=========================================
Replaces install-single.py and install-multi.py.
Handles single and multi-entity from one script.

Single entity (no nginx unless --domain):
  sudo python3 install.py                            # interactive
  sudo python3 install.py --url https://crm.example.com
  sudo python3 install.py --url https://crm.example.com --domain mcp.yourcompany.com --email you@example.com

Multi entity (nginx always):
  sudo python3 install.py entities.json
  sudo python3 install.py --config entities.json
  sudo python3 install.py --add                      # add new entities without touching existing
  sudo python3 install.py --remove crm1 crm2        # remove specific entities
  sudo python3 install.py --domain mcp.yourcompany.com --email you@example.com  # enable HTTPS

Operations (both modes):
  sudo python3 install.py --status
  sudo python3 install.py --update
  sudo python3 install.py --monitoring               # install Prometheus/Grafana/Loki stack
  sudo python3 install.py --uninstall                # single only

entities.json format:
  {
    "crm1": {"label": "Main CRM", "endpoint": "https://crm.example.com/service/v4_1/rest.php", "port": 3101},
    "crm2": {"label": "Client B", "endpoint": "https://crm2.example.com/service/v4_1/rest.php", "port": 3102, "tls_skip": true}
  }

Options:
  --url        CRM base URL or full rest.php URL (single-entity CLI mode)
  --code       Entity code for --url mode (default: suitecrm)
  --label      Service description for --url mode (default: My CRM)
  --port       Listen port for single entity (default: 3101)
  --tls-skip   Disable TLS cert verification (self-signed certs only)
  --domain     Domain for HTTPS via Let's Encrypt
  --email      Email for Let's Encrypt cert (required with --domain)
  --config     Path to entities.json (default: entities.json)
  --add        Add new entities only (no reinstall of existing)
  --remove     Remove entity codes
  --status     Show service status
  --update     Update server code and restart
  --monitoring Install Prometheus/Grafana/Loki/Alertmanager monitoring stack via Docker
  --uninstall  Remove single-entity install (single mode only)

SSH provisioning (LDAP/SSO deployments):
  sudo python3 install.py --setup-crm-host crm1   # deploy provision script to CRM VM for entity crm1

  SSH provisioning lets the gateway auto-create CRM API passwords for LDAP/SSO users at login
  time. The gateway SSHes into each CRM VM and runs /usr/local/bin/crm-provision-user.
  The interactive setup wizard will ask about this during a fresh install.
"""

import os, sys, subprocess, json, argparse, shutil, re, socket, time, secrets, getpass, ssl, shlex
from pathlib import Path
from urllib.parse import urlparse
import urllib.request
import urllib.error
import urllib.parse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SERVER_DIR         = "/opt/suitecrm-mcp-server"
ENV_DIR            = "/etc/suitecrm-mcp"
ENV_FILE           = "/etc/suitecrm-mcp/gateway.env"   # single-entity env
ENTITIES_JSON      = "/etc/suitecrm-mcp/entities.json"  # runtime entity config for the server
CRM_HOSTS_FILE     = "/etc/suitecrm-mcp/crm-hosts.json"  # SSH provisioning config
# NOTE: user-profiles.json is no longer used. Profiles are stored in Redis
# under the crm:profiles hash (key = SSO sub, value = JSON). Use mcp-admin to manage them.
DOMAIN_FILE        = "/etc/suitecrm-mcp/domain"
AUTH_ENV_FILE      = "/etc/suitecrm-mcp/auth.env"
AUTH_SVC_NAME      = "suitecrm-mcp-auth"
PROFILE_ADMIN_DEST = "/usr/local/bin/mcp-admin"
NGINX_CONF    = "/etc/nginx/sites-available/suitecrm-mcp"
NGINX_LINK    = "/etc/nginx/sites-enabled/suitecrm-mcp"
NGINX_PORT    = 8080   # multi-entity plain HTTP listen port
SVC_USER      = "suitecrm-mcp"
SVC_NAME      = "suitecrm-mcp"  # single-entity service name
MONITORING_DIR      = "/opt/suitecrm-mcp-monitoring"
MONITORING_SVC_NAME = "suitecrm-mcp-monitoring"

# Common SuiteCRM REST API path patterns (in order of likelihood)
API_PATH_PATTERNS = [
    "/service/v4_1/rest.php",
    "/legacy/service/v4_1/rest.php",
    "/crm/service/v4_1/rest.php",
    "/suitecrm/service/v4_1/rest.php",
    "/suite/service/v4_1/rest.php",
    "/service/v4/rest.php",
    "/legacy/service/v4/rest.php",
    "/crm/service/v4/rest.php",
]

API_DETECT_TIMEOUT = 5  # seconds per probe

# ---------------------------------------------------------------------------
# Validation regexes - all privileged commands use list form, never shell=True
# ---------------------------------------------------------------------------

SAFE_DOMAIN_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9.-]+$')
SAFE_EMAIL_RE  = re.compile(r'^[^@\s,;|&<>]+@[^@\s,;|&<>]+\.[^@\s,;|&<>]+$')
SAFE_CODE_RE   = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$')
SAFE_HOST_RE   = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$')
SAFE_USER_RE   = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

RED = "\033[0;31m"; GREEN = "\033[0;32m"; YELLOW = "\033[1;33m"; CYAN = "\033[0;36m"; NC = "\033[0m"

def info(m):  print(f"{CYAN}[INFO]{NC} {m}")
def ok(m):    print(f"{GREEN}[OK]{NC} {m}")
def warn(m):  print(f"{YELLOW}[WARN]{NC} {m}")
def error(m): print(f"{RED}[ERROR]{NC} {m}"); sys.exit(1)

def _server_ip():
    """Return the primary non-loopback IP of this machine, or 'YOUR_SERVER_IP'."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "YOUR_SERVER_IP"

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

def validate_domain(d):
    if not SAFE_DOMAIN_RE.match(d):
        error(f"Invalid domain: {d!r} - must contain only letters, digits, hyphens, and dots")

def validate_email(e):
    if not SAFE_EMAIL_RE.match(e):
        error(f"Invalid email address: {e!r}")

def validate_code(c):
    if not SAFE_CODE_RE.match(c):
        error(f"Invalid entity code: {c!r} - must start with a letter or digit and contain only "
              "letters, digits, hyphens, and underscores")

# ---------------------------------------------------------------------------
# Shell helpers
# ---------------------------------------------------------------------------

def run(cmd, check=True, capture=False, cwd=None):
    # String commands are only used for the NodeSource curl|bash pipeline
    # (no list form possible for that specific operation).
    # All other privileged paths use list form to avoid shell injection.
    if isinstance(cmd, str):
        cmd = ["bash", "-c", cmd]
    r = subprocess.run(cmd, capture_output=capture, text=True, cwd=cwd)
    if check and r.returncode != 0:
        error(f"Command failed: {' '.join(cmd)}\n{r.stderr.strip() if capture else ''}")
    return r

def write_file(path, content, mode=None):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    if mode:
        run(["chmod", mode, path])

def node_bin():
    return shutil.which("node") or "/usr/bin/node"

def script_dir():
    return Path(__file__).parent.resolve()

# ---------------------------------------------------------------------------
# Endpoint auto-detection
# ---------------------------------------------------------------------------

def _test_rest_api(endpoint):
    """POST get_server_info to endpoint. Returns (True, version) on success."""
    try:
        data = urllib.parse.urlencode({
            "method": "get_server_info",
            "input_type": "JSON",
            "response_type": "JSON",
            "rest_data": json.dumps({}),
        }).encode("utf-8")
        req = urllib.request.Request(endpoint, data=data, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("User-Agent", "SuiteCRM-MCP-Installer/1.5")
        with urllib.request.urlopen(req, timeout=API_DETECT_TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if "version" in result or "flavor" in result:
                return True, result.get("version", "unknown")
    except Exception:
        pass
    return False, None

def auto_detect_endpoint(base_url, verbose=False):
    """
    Try each API_PATH_PATTERNS against base_url.
    Returns (endpoint_url, version_string) or (None, None).
    """
    parsed = urlparse(base_url)
    base = f"{parsed.scheme}://{parsed.netloc}"

    if verbose:
        info(f"Auto-detecting REST API endpoint for {base} ...")

    for pattern in API_PATH_PATTERNS:
        endpoint = base + pattern
        if verbose:
            print(f"  Trying {pattern} ...", end=" ", flush=True)
        valid, version = _test_rest_api(endpoint)
        if valid:
            if verbose:
                print(f"{GREEN}found (SuiteCRM {version}){NC}")
            return endpoint, version
        else:
            if verbose:
                print("not found")

    return None, None

GRAPHQL_PATHS = ["/api/graphql", "/graphql"]

def _test_graphql_api(base_url):
    """
    Check if a SuiteCRM v8 GraphQL endpoint exists at base_url.
    A 200/400/401/403 response all mean the endpoint is present (auth required or query error).
    Returns (True, endpoint_url) or (False, None).
    """
    parsed = urlparse(base_url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    for path in GRAPHQL_PATHS:
        endpoint = base + path
        try:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps({"query": "{__typename}"}).encode("utf-8"),
                method="POST",
            )
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "SuiteCRM-MCP-Installer/1.5")
            with urllib.request.urlopen(req, timeout=API_DETECT_TIMEOUT, context=ctx):
                return True, endpoint  # 200 — endpoint live
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403):  # endpoint exists, auth/query error expected
                return True, endpoint
        except Exception:
            pass
    return False, None

# ---------------------------------------------------------------------------
# Interactive setup
# ---------------------------------------------------------------------------

def _prompt(label, default=None):
    suffix = f" [{default}]" if default else ""
    val = input(f"  {label}{suffix}: ").strip()
    return val or default

def _collect_v4_endpoint(base_url, code):
    """Detect or prompt for a v4 REST endpoint. Returns endpoint string."""
    if "rest.php" in base_url:
        ok(f"  [{code}] Using provided v4 endpoint: {base_url}")
        return base_url
    info(f"  [{code}] Auto-detecting v4 REST endpoint ...")
    endpoint, version = auto_detect_endpoint(base_url, verbose=True)
    if endpoint:
        ok(f"  [{code}] Detected v4: {endpoint}" + (f" (SuiteCRM {version})" if version else ""))
        return endpoint
    warn(f"  [{code}] v4 auto-detection failed.")
    print("  Common patterns:")
    for p in API_PATH_PATTERNS[:4]:
        print(f"    {base_url}{p}")
    endpoint = _prompt(f"  [{code}] Full v4 REST endpoint")
    if not endpoint:
        error("v4 endpoint is required")
    return endpoint


def _collect_v8_endpoint(base_url, code):
    """Detect or prompt for a v8 GraphQL endpoint + OAuth2 creds. Returns (endpoint, client_id, client_secret, auth_endpoint)."""
    if "/graphql" in base_url:
        endpoint = base_url
        ok(f"  [{code}] Using provided v8 endpoint: {endpoint}")
    else:
        info(f"  [{code}] Auto-detecting v8 GraphQL endpoint ...")
        gql_found, endpoint = _test_graphql_api(base_url)
        if gql_found:
            ok(f"  [{code}] Detected v8 GraphQL: {endpoint}")
        else:
            warn(f"  [{code}] v8 auto-detection failed.")
            parsed = urlparse(base_url)
            base = f"{parsed.scheme}://{parsed.netloc}"
            print(f"  Expected: {base}/api/graphql")
            endpoint = _prompt(f"  [{code}] Full v8 GraphQL endpoint", f"{base}/api/graphql")
            if not endpoint:
                error("v8 endpoint is required")

    print()
    info(f"  [{code}] OAuth2 client credentials (from SuiteCRM Admin > OAuth2 Clients)")
    client_id     = _prompt(f"  [{code}] Client ID")
    client_secret = getpass.getpass(f"  [{code}] Client Secret: ").strip()
    parsed = urlparse(endpoint)
    default_auth  = f"{parsed.scheme}://{parsed.netloc}/Api/access_token"
    auth_endpoint = _prompt(f"  [{code}] Token URL", default_auth)
    return endpoint, client_id, client_secret, auth_endpoint


def prompt_entity_config(entity_code=None, default_port=3101, api_mode=None):
    """
    Interactively gather one entity's config.
    api_mode: "v4" | "v8" | "both" — if None, prompted interactively.
    Returns entities.json-style dict plus 'code' key.
    """
    print()
    code = entity_code or _prompt("Entity code (letters, digits, hyphens, underscores)", "main")
    validate_code(code)

    default_label = code.replace("_", " ").replace("-", " ").title()
    label = _prompt(f"  [{code}] Label", default_label)

    base_url = _prompt(f"  [{code}] CRM base URL (e.g. https://crm.example.com)")
    if not base_url:
        error("CRM URL is required")
    if not base_url.startswith(("http://", "https://")):
        base_url = "https://" + base_url

    if api_mode is None:
        print()
        print(f"  [{code}] Which SuiteCRM API version are you connecting to?")
        print("    [1] v4 only  — legacy REST  (SuiteCRM 7.x / older)")
        print("    [2] v8 only  — GraphQL      (SuiteCRM 8.x)")
        print("    [3] Both     — v4 REST + v8 GraphQL on the same CRM")
        api_choice = input(f"  [{code}] API version [1/2/3, default=1]: ").strip()
        if api_choice == "2":
            api_mode = "v8"
        elif api_choice == "3":
            api_mode = "both"
        else:
            api_mode = "v4"

    # Collect endpoints based on chosen API mode
    v4_ep = v8_ep = client_id = client_secret = auth_endpoint = ""

    if api_mode in ("v4", "both"):
        print()
        v4_ep = _collect_v4_endpoint(base_url, code)

    if api_mode in ("v8", "both"):
        print()
        v8_ep, client_id, client_secret, auth_endpoint = _collect_v8_endpoint(base_url, code)

    # Primary endpoint: v8 takes precedence when both are set
    endpoint = v8_ep if v8_ep else v4_ep

    port_str = _prompt(f"  [{code}] Listen port", str(default_port))
    try:
        port = int(port_str)
    except (TypeError, ValueError):
        error(f"Invalid port: {port_str!r}")

    tls_skip = input(f"  [{code}] Disable TLS verification for self-signed certs? [y/N]: ").strip().lower() in ("y", "yes")
    group    = _prompt(f"  [{code}] Required AD/OAuth group (blank = any authenticated user)", "")

    result = {
        "code":     code,
        "label":    label,
        "endpoint": endpoint,
        "port":     port,
        "tls_skip": tls_skip,
    }
    if group:
        result["group"] = group
    if v4_ep and v8_ep:
        result["v4_endpoint"] = v4_ep   # stored for reference; primary endpoint is v8
    if client_id:
        result["client_id"]     = client_id
        result["client_secret"] = client_secret
        result["auth_endpoint"] = auth_endpoint
    return result

def interactive_setup():
    """
    Full interactive wizard. Returns (entities_dict, is_multi) where
    entities_dict is keyed by code (entities.json format).
    """
    print()
    info("=" * 60)
    info("SUITECRM MCP GATEWAY - INTERACTIVE SETUP")
    info("=" * 60)
    print()
    print("No configuration provided. Let's set up your gateway.")
    print()

    num_str = input("  How many CRM instances do you want to connect? [1]: ").strip()
    try:
        num = int(num_str) if num_str else 1
    except ValueError:
        num = 1
    if num < 1:
        error("Must configure at least 1 entity")

    entities = {}
    for i in range(num):
        cfg = prompt_entity_config(default_port=3101 + i)
        entities[cfg["code"]] = {k: v for k, v in cfg.items() if k != "code"}

    # Offer to save
    print()
    if input("  Save configuration to entities.json? [Y/n]: ").strip().lower() in ("", "y", "yes"):
        with open("entities.json", "w") as f:
            json.dump(entities, f, indent=2)
        ok("Saved to entities.json")

    return entities

# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def load_entities(config_path):
    """Load and validate entities.json. Returns dict keyed by code."""
    p = Path(config_path)
    if not p.exists():
        error(f"Config file not found: {config_path}\n"
              "Copy entities.example.json to entities.json and fill it in.")
    with open(p) as f:
        try:
            entities = json.load(f)
        except json.JSONDecodeError as e:
            error(f"Invalid JSON in {config_path}: {e}")

    ports_seen = {}
    for code, data in entities.items():
        validate_code(code)
        if "endpoint" not in data and "url" not in data:
            error(f"Entity '{code}' missing 'endpoint' (or 'url' for auto-detection)")
        if "endpoint" not in data:
            # New-format: auto-detect from 'url'
            info(f"Auto-detecting endpoint for {code} ...")
            ep, _ = auto_detect_endpoint(data["url"], verbose=True)
            if not ep:
                error(f"Could not auto-detect endpoint for '{code}'. "
                      "Add 'endpoint' key explicitly.")
            data["endpoint"] = ep
        if "port" not in data:
            error(f"Entity '{code}' missing required field: port")
        port = data["port"]
        if port in ports_seen:
            error(f"Port {port} used by both '{code}' and '{ports_seen[port]}' - "
                  "each entity needs a unique port")
        ports_seen[port] = code

    return entities

# ---------------------------------------------------------------------------
# OAuth / auth config
# ---------------------------------------------------------------------------

def prompt_oauth_config(args, domain=None):
    """
    Gather OAuth2/OIDC configuration interactively or from CLI flags.
    Returns a dict with all required OAuth env vars.
    """
    print()
    info("=" * 60)
    info("OAUTH2 CONFIGURATION")
    info("=" * 60)
    print()
    print("  The gateway uses OAuth2/OIDC for user authentication.")
    print("  You will need an app registration in Auth0, Azure AD, or")
    print("  any OIDC provider. See docs/auth0-setup.md for guidance.")
    print()

    auth0_domain = getattr(args, "oauth_issuer", None) or _prompt(
        "Auth0 domain (e.g. your-tenant.auth0.com)"
    )
    if not auth0_domain:
        error("Auth0 domain is required")
    auth0_domain = auth0_domain.rstrip("/").removeprefix("https://")

    client_id = getattr(args, "oauth_client_id", None) or _prompt("Auth0 client ID")
    if not client_id:
        error("Auth0 client ID is required")

    client_secret = getattr(args, "oauth_client_secret", None) or getpass.getpass("  Auth0 client secret: ")
    if not client_secret:
        error("Auth0 client secret is required")

    audience = getattr(args, "oauth_audience", None) or _prompt(
        "Auth0 audience (your API identifier - required)", ""
    )
    if not audience:
        error("Auth0 audience is required")

    # Derive gateway URL
    if domain:
        default_gw = f"https://{domain}"
    else:
        default_gw = getattr(args, "gateway_url", None) or ""
    gateway_url = getattr(args, "gateway_url", None) or _prompt(
        "Gateway public URL (e.g. https://mcp.yourdomain.com)", default_gw
    )
    if not gateway_url:
        error("Gateway public URL is required (used to build the OAuth redirect URI)")
    gateway_url = gateway_url.rstrip("/")

    session_ttl = getattr(args, "session_ttl_days", None) or _prompt(
        "Session TTL in days (default: 30)", "30"
    ) or "30"

    groups_claim = getattr(args, "oauth_groups_claim", None) or _prompt(
        "JWT groups claim name (leave blank for default: AUTH0_AUDIENCE + '/groups')", ""
    ) or ""

    ok(f"Redirect URI: {gateway_url}/auth/callback")
    print()

    cfg = {
        "AUTH0_DOMAIN":      auth0_domain,
        "AUTH0_CLIENT_ID":   client_id,
        "AUTH0_CLIENT_SECRET": client_secret,
        "AUTH0_AUDIENCE":    audience,
        "GATEWAY_PUBLIC_URL": gateway_url,
        "SESSION_TTL_DAYS":  session_ttl,
    }
    if groups_claim:
        cfg["OAUTH_GROUPS_CLAIM"] = groups_claim
    return cfg


def write_entities_json(entities):
    """Write /etc/suitecrm-mcp/entities.json for the gateway to read at runtime."""
    # Include only the fields the server needs
    out = {}
    for code, data in entities.items():
        entry = {
            "label":    data.get("label", code),
            "endpoint": data["endpoint"],
            "port":     data["port"],
        }
        if data.get("tls_skip"):
            entry["tls_skip"] = True
        if data.get("group"):
            entry["group"] = data["group"]
        out[code] = entry

    write_file(ENTITIES_JSON, json.dumps(out, indent=2), mode="640")
    run(["chown", f"root:{SVC_USER}", ENTITIES_JSON])
    ok(f"Entities config: {ENTITIES_JSON}")


# ---------------------------------------------------------------------------
# Auth service install
# ---------------------------------------------------------------------------

def install_auth_service(auth_cfg):
    """Write auth.env and a systemd unit for suitecrm-mcp-auth (auth.mjs)."""
    pass_file = Path(ENV_DIR) / "redis_pass"
    redis_pass = pass_file.read_text().strip() if pass_file.exists() else ""
    default_redis = f"redis://:{redis_pass}@127.0.0.1:6379" if redis_pass else "redis://127.0.0.1:6379"

    lines = [
        "# SuiteCRM MCP Auth Service",
        f"AUTH0_DOMAIN={auth_cfg['AUTH0_DOMAIN']}",
        f"AUTH0_CLIENT_ID={auth_cfg['AUTH0_CLIENT_ID']}",
        f"AUTH0_CLIENT_SECRET={auth_cfg['AUTH0_CLIENT_SECRET']}",
        f"AUTH0_AUDIENCE={auth_cfg['AUTH0_AUDIENCE']}",
        f"GATEWAY_PUBLIC_URL={auth_cfg['GATEWAY_PUBLIC_URL']}",
        f"SESSION_TTL_DAYS={auth_cfg.get('SESSION_TTL_DAYS', '30')}",
        *([ f"OAUTH_GROUPS_CLAIM={auth_cfg['OAUTH_GROUPS_CLAIM']}" ] if auth_cfg.get('OAUTH_GROUPS_CLAIM') else []),
        "PORT=3100",
        "BIND_HOST=127.0.0.1",
        "METRICS_PORT=9091",
        "METRICS_BIND=0.0.0.0",
        f"REDIS_URL={auth_cfg.get('REDIS_URL', default_redis)}",
        "TRUST_PROXY=1",
        "",
    ]
    write_file(AUTH_ENV_FILE, "\n".join(lines), mode="600")
    run(["chown", f"{SVC_USER}:{SVC_USER}", AUTH_ENV_FILE])
    ok(f"  Auth env: {AUTH_ENV_FILE}")

    nb = node_bin()
    unit = (
        f"[Unit]\n"
        f"Description=SuiteCRM MCP Auth Service\n"
        f"After=network.target\n\n"
        f"[Service]\n"
        f"Type=simple\n"
        f"User={SVC_USER}\n"
        f"Group={SVC_USER}\n"
        f"EnvironmentFile={AUTH_ENV_FILE}\n"
        f"ExecStart={nb} {SERVER_DIR}/auth.mjs\n"
        f"Restart=always\n"
        f"RestartSec=5\n"
        f"KillMode=control-group\n"
        f"StartLimitIntervalSec=120\n"
        f"StartLimitBurst=10\n"
        f"StandardOutput=journal\n"
        f"StandardError=journal\n"
        f"SyslogIdentifier={AUTH_SVC_NAME}\n"
        f"NoNewPrivileges=yes\n"
        f"PrivateTmp=yes\n"
        f"ProtectSystem=strict\n"
        f"ProtectHome=yes\n"
        f"ReadWritePaths=/etc/suitecrm-mcp /opt/suitecrm-mcp-server\n\n"
        f"[Install]\n"
        f"WantedBy=multi-user.target\n"
    )
    unit_path = f"/etc/systemd/system/{AUTH_SVC_NAME}.service"
    write_file(unit_path, unit)
    ok(f"  Auth service: {unit_path}")


# ---------------------------------------------------------------------------
# Admin tool + SSH provisioning helpers
# ---------------------------------------------------------------------------

def install_profile_admin():
    src = script_dir() / "tools" / "mcp-admin"
    mjs = script_dir() / "tools" / "mcp-admin.mjs"
    if not src.exists():
        warn("tools/mcp-admin not found - skipping admin tool install")
        return
    shutil.copy(src, PROFILE_ADMIN_DEST)
    run(["chmod", "750", PROFILE_ADMIN_DEST])
    run(["chown", "root:root", PROFILE_ADMIN_DEST])
    # mcp-admin.mjs must live in SERVER_DIR so Node.js resolves its imports
    # from the server's node_modules (ES modules ignore NODE_PATH).
    if mjs.exists():
        shutil.copy(mjs, f"{SERVER_DIR}/mcp-admin.mjs")
        run(["chmod", "750", f"{SERVER_DIR}/mcp-admin.mjs"])
        run(["chown", f"{SVC_USER}:{SVC_USER}", f"{SERVER_DIR}/mcp-admin.mjs"])
    ok(f"Admin tool: {PROFILE_ADMIN_DEST}")


def write_crm_hosts(crm_hosts):
    write_file(CRM_HOSTS_FILE, json.dumps(crm_hosts, indent=2), mode="640")
    run(["chown", f"root:{SVC_USER}", CRM_HOSTS_FILE])
    ok(f"SSH provisioning config: {CRM_HOSTS_FILE}")


def prompt_ssh_provisioning(entities):
    """
    Ask admin if SSH provisioning should be enabled per entity.
    Returns a crm-hosts.json-style dict (may be empty if skipped).
    """
    print()
    info("=" * 60)
    info("SSH PROVISIONING SETUP (OPTIONAL)")
    info("=" * 60)
    print()
    print("  SSH provisioning lets the gateway auto-create CRM API")
    print("  passwords for LDAP/SSO users at login time. The gateway")
    print("  SSHes into each CRM VM and runs the provision script.")
    print()
    print("  Skip this if users have local CRM accounts (not LDAP/SSO),")
    print("  or if you prefer to set CRM credentials manually.")
    print()

    enable = input("  Enable SSH provisioning? [y/N]: ").strip().lower()
    if enable not in ("y", "yes"):
        info("SSH provisioning skipped. You can enable it later by re-running install.py.")
        return {}

    crm_hosts = {}
    for code in entities:
        print()
        info(f"  Entity: {code}")
        ssh_host = _prompt(f"  CRM VM SSH host (IP or hostname, blank to skip)")
        if not ssh_host:
            info(f"  Skipping '{code}'")
            continue
        if not SAFE_HOST_RE.match(ssh_host):
            warn(f"  Invalid hostname '{ssh_host}' - skipping '{code}'")
            continue
        ssh_user = _prompt("  SSH user", "ubuntu")
        if not SAFE_USER_RE.match(ssh_user):
            warn(f"  Invalid SSH user '{ssh_user}' - skipping '{code}'")
            continue
        ssh_key = _prompt("  Path to SSH private key", "/etc/suitecrm-mcp/crm-ssh-key")
        api_path = _prompt("  API_PATH override (blank = auto-detect, only needed for v4 REST legacy)", "")
        # SUITECRM_CONFIG is auto-detected on the CRM VM via find-suitecrm-config.sh;
        # 'command' is built by setup_crm_host after detection.
        entry = {
            "ssh_host": ssh_host,
            "ssh_user": ssh_user,
            "ssh_key":  ssh_key,
        }
        if api_path:
            entry["api_path"] = api_path
        crm_hosts[code] = entry
        ok(f"  SSH provisioning enabled for '{code}'")

    return crm_hosts


def setup_crm_host(code, host_cfg):
    """
    Deploy tools/crm-provision-user.sh to the CRM VM as /usr/local/bin/crm-provision-user,
    then auto-detect SUITECRM_CONFIG via find-suitecrm-config.sh and build the command
    string. Updates host_cfg in place with the detected 'command' field.
    Returns True on success, False on failure (non-fatal when called during install).
    """
    ssh_host = host_cfg.get("ssh_host", "")
    ssh_user = host_cfg.get("ssh_user", "ubuntu")
    ssh_key  = host_cfg.get("ssh_key", "/etc/suitecrm-mcp/crm-ssh-key")

    if not SAFE_HOST_RE.match(ssh_host):
        warn(f"  [{code}] Invalid ssh_host '{ssh_host}' in crm-hosts.json - skipping")
        return False
    if not SAFE_USER_RE.match(ssh_user):
        warn(f"  [{code}] Invalid ssh_user '{ssh_user}' in crm-hosts.json - skipping")
        return False

    src = script_dir() / "tools" / "crm-provision-user.sh"
    if not src.exists():
        warn(f"  [{code}] tools/crm-provision-user.sh not found - run from the repo root")
        return False

    find_script = script_dir() / "scripts" / "find-suitecrm-config.sh"
    if not find_script.exists():
        warn(f"  [{code}] scripts/find-suitecrm-config.sh not found - run from the repo root")
        return False

    ssh_opts = ["-i", ssh_key, "-o", "StrictHostKeyChecking=accept-new",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "ConnectTimeout=15", "-o", "BatchMode=yes"]
    target = f"{ssh_user}@{ssh_host}"
    provision_bin = "/usr/local/bin/crm-provision-user"

    info(f"  [{code}] Copying provision script to {target} ...")
    # Remove stale copy first — a previous failed run can leave it owned by root
    run(["ssh"] + ssh_opts + [target, "sudo rm -f /tmp/crm-provision-user"],
        check=False, capture=True)
    r = run(["scp"] + ssh_opts + [str(src), f"{target}:/tmp/crm-provision-user"],
            check=False, capture=True)
    if r.returncode != 0:
        warn(f"  [{code}] scp failed: {r.stderr.strip()[:200]}")
        return False

    r = run(["ssh"] + ssh_opts + [target,
             f"sudo mv /tmp/crm-provision-user {provision_bin} && sudo chmod 755 {provision_bin}"],
            check=False, capture=True)
    if r.returncode != 0:
        warn(f"  [{code}] Remote install failed: {r.stderr.strip()[:200]}")
        return False

    ok(f"  [{code}] Provision script deployed to {ssh_host}:{provision_bin}")

    # Resolve SUITECRM_CONFIG — mirrors ansible/deploy.yml logic:
    # 1. Read from /etc/environment if already set (persisted by previous run)
    # 2. Otherwise run find-suitecrm-config.sh as root and persist the result
    # 3. Fall back to manual prompt if discovery fails
    info(f"  [{code}] Resolving SUITECRM_CONFIG on {ssh_host} ...")
    config_path = ""

    # Step 1: check /etc/environment
    r = subprocess.run(
        ["ssh"] + ssh_opts + [target,
         "grep '^SUITECRM_CONFIG=' /etc/environment 2>/dev/null | cut -d= -f2 | head -1"],
        capture_output=True, text=True,
    )
    candidate = r.stdout.strip()
    if candidate.startswith("/"):
        config_path = candidate
        ok(f"  [{code}] SUITECRM_CONFIG already set: {config_path}")

    # Step 2: discover — same find command used inside crm-provision-user.sh
    if not config_path:
        info(f"  [{code}] Not set — running discovery (may take a minute) ...")
        find_cmd = (
            "sudo bash -c '"
            "find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o"
            " -name config.php -readable -print 2>/dev/null"
            " | xargs -r grep -l dbconfig 2>/dev/null | head -1'"
        )
        r = subprocess.run(
            ["ssh"] + ssh_opts + [target, find_cmd],
            capture_output=True, text=True,
        )
        candidate = r.stdout.strip()
        if not candidate and r.stderr.strip():
            warn(f"  [{code}] Discovery stderr: {r.stderr.strip()[:300]}")
        if candidate.startswith("/"):
            config_path = candidate
            if not re.match(r'^/[a-zA-Z0-9/_.\-]+$', config_path):
                warn(f"  [{code}] Suspicious config path rejected: {config_path}")
                config_path = ""
            else:
                # Persist to /etc/environment so future runs skip discovery
                quoted = shlex.quote(config_path)
                subprocess.run(
                    ["ssh"] + ssh_opts + [target,
                     f"sudo grep -q '^SUITECRM_CONFIG=' /etc/environment 2>/dev/null || "
                     f"echo SUITECRM_CONFIG={quoted} | sudo tee -a /etc/environment"],
                    capture_output=True, text=True,
                )
                ok(f"  [{code}] SUITECRM_CONFIG={config_path}")

    # Step 3: manual prompt
    if not config_path:
        warn(f"  [{code}] Could not auto-detect config.php on {ssh_host}")
        config_path = _prompt(f"  [{code}] Enter SUITECRM_CONFIG path on the CRM VM").strip()
        if not config_path or not config_path.startswith("/"):
            warn(f"  [{code}] No valid path provided — skipping")
            return False
        ok(f"  [{code}] SUITECRM_CONFIG={config_path}")

    # Build runtime command stored in crm-hosts.json
    cmd_parts = [f"SUITECRM_CONFIG={shlex.quote(config_path)}"]
    api_path = host_cfg.get("api_path", "")
    if api_path:
        cmd_parts.append(f"API_PATH={shlex.quote(api_path)}")
    cmd_parts.append(provision_bin)
    host_cfg["command"] = " ".join(cmd_parts)
    host_cfg.pop("api_path", None)  # api_path is now embedded in command

    return True


# ---------------------------------------------------------------------------
# System-level setup
# ---------------------------------------------------------------------------

def ensure_service_user():
    r = run(["id", SVC_USER], check=False, capture=True)
    if r.returncode != 0:
        run(["useradd", "--system", "--no-create-home",
             "--shell", "/usr/sbin/nologin", SVC_USER])
        ok(f"Created system user: {SVC_USER}")
    else:
        ok(f"Service user exists: {SVC_USER}")

def install_node():
    if not shutil.which("node"):
        info("Installing Node.js LTS ...")
        # curl | bash is the only accepted shell pipeline - NodeSource provides no alternative
        run("curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -")
        run(["apt-get", "install", "-y", "nodejs"])
        ok(f"Node.js installed: {run(['node', '--version'], capture=True).stdout.strip()}")
    else:
        ok(f"Node.js: {run(['node', '--version'], capture=True).stdout.strip()}")

def install_nginx():
    if not shutil.which("nginx"):
        info("Installing nginx ...")
        run(["apt-get", "update", "-qq"])
        run(["apt-get", "install", "-y", "nginx"])
        ok("nginx installed")
    else:
        ok("nginx: present")

def install_certbot():
    if not shutil.which("certbot"):
        info("Installing certbot ...")
        run(["apt-get", "install", "-y", "certbot", "python3-certbot-nginx"])
        ok("certbot installed")
    else:
        ok("certbot: present")

def install_redis():
    if not shutil.which("redis-server"):
        info("Installing Redis ...")
        run(["apt-get", "update", "-qq"])
        run(["apt-get", "install", "-y", "redis-server"])
        ok("Redis installed")
    else:
        ok("Redis: present")

    # Secure Redis and configure persistence
    redis_conf = "/etc/redis/redis.conf"
    if Path(redis_conf).exists():
        content = Path(redis_conf).read_text()
        changed = False
        pass_file = Path(ENV_DIR) / "redis_pass"
        if pass_file.exists():
            redis_pass = pass_file.read_text().strip()
        else:
            redis_pass = secrets.token_urlsafe(16)
            os.makedirs(ENV_DIR, exist_ok=True)
            fd = os.open(str(pass_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(redis_pass)
            
        if "requirepass " not in content:
            content += f"\nrequirepass {redis_pass}\n"
            changed = True
        else:
            # Update existing requirepass line to match the stored password
            import re as _re
            new_content = _re.sub(r'(?m)^requirepass .*$', f'requirepass {redis_pass}', content)
            if new_content != content:
                content = new_content
                changed = True

        if "maxmemory-policy volatile-lru" not in content:
            if "maxmemory-policy allkeys-lru" in content:
                content = content.replace("maxmemory-policy allkeys-lru", "maxmemory-policy volatile-lru")
            else:
                content += "\nmaxmemory 256mb\nmaxmemory-policy volatile-lru\n"
            changed = True

        if changed:
            orig_mode = Path(redis_conf).stat().st_mode & 0o777
            fd = os.open(redis_conf, os.O_WRONLY | os.O_TRUNC, orig_mode)
            with os.fdopen(fd, 'w') as f:
                f.write(content)
            run(["systemctl", "restart", "redis-server"])
            ok("Redis configured with persistence, maxmemory, and authentication")

        # Always enforce the password at runtime in case the config was out of sync
        if redis_pass:
            import subprocess as _sp
            _sp.run(["redis-cli", "config", "set", "requirepass", redis_pass],
                    capture_output=True)

def install_docker():
    if shutil.which("docker"):
        r = run(["docker", "--version"], capture=True, check=False)
        ok(f"Docker: {r.stdout.strip()}")
        return
    info("Installing Docker Engine ...")
    run(["apt-get", "update", "-qq"])
    run(["apt-get", "install", "-y", "ca-certificates", "curl", "gnupg"])
    os.makedirs("/etc/apt/keyrings", exist_ok=True)
    run("curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg")
    run(["chmod", "a+r", "/etc/apt/keyrings/docker.gpg"])
    arch_r = run(["dpkg", "--print-architecture"], capture=True)
    arch = arch_r.stdout.strip()
    codename_r = run(["bash", "-c", ". /etc/os-release && echo $VERSION_CODENAME"], capture=True)
    codename = codename_r.stdout.strip()
    repo_line = (
        f"deb [arch={arch} signed-by=/etc/apt/keyrings/docker.gpg] "
        f"https://download.docker.com/linux/ubuntu {codename} stable"
    )
    write_file("/etc/apt/sources.list.d/docker.list", repo_line + "\n")
    run(["apt-get", "update", "-qq"])
    run(["apt-get", "install", "-y",
         "docker-ce", "docker-ce-cli", "containerd.io",
         "docker-buildx-plugin", "docker-compose-plugin"])
    run(["systemctl", "enable", "--now", "docker"])
    ok(f"Docker installed: {run(['docker', '--version'], capture=True).stdout.strip()}")


# ---------------------------------------------------------------------------
# Monitoring stack
# ---------------------------------------------------------------------------

def _monitoring_prometheus_yml(entities):
    """Generate prometheus.yml for a systemd-based multi/single entity install."""
    jobs = [
        "  - job_name: suitecrm-mcp-auth\n"
        "    static_configs:\n"
        "      - targets: ['host-gateway:9091']\n"
        "        labels:\n"
        "          service: auth\n"
    ]
    for code, data in entities.items():
        metrics_port = data["port"] + 6000
        jobs.append(
            f"  - job_name: suitecrm-mcp-{code}\n"
            f"    static_configs:\n"
            f"      - targets: ['host-gateway:{metrics_port}']\n"
            f"        labels:\n"
            f"          entity: {code}\n"
        )
    jobs.append(
        "  - job_name: redis\n"
        "    static_configs:\n"
        "      - targets: ['host-gateway:9121']\n"
        "        labels:\n"
        "          service: redis\n"
    )
    return (
        "global:\n"
        "  scrape_interval: 15s\n"
        "  evaluation_interval: 15s\n\n"
        "alerting:\n"
        "  alertmanagers:\n"
        "    - static_configs:\n"
        "        - targets: ['alertmanager:9093']\n\n"
        "rule_files:\n"
        "  - \"rules.yml\"\n\n"
        "scrape_configs:\n"
        + "".join(f"\n{j}" for j in jobs)
    )


def _write_monitoring_env(domain, redis_pass):
    """Write/update the .env file for the monitoring stack."""
    env_file = Path(MONITORING_DIR) / ".env"
    gateway_url = f"https://{domain}" if domain else f"http://{_server_ip()}:{NGINX_PORT}"
    redis_addr  = f"redis://:{redis_pass}@127.0.0.1:6379" if redis_pass else "redis://127.0.0.1:6379"
    redis_hosts = f"local:127.0.0.1:6379:0:{redis_pass}" if redis_pass else "local:127.0.0.1:6379"

    if env_file.exists():
        # Preserve existing passwords; only update connection/URL vars
        content = env_file.read_text()
        def _set(text, key, val):
            import re as _re
            pattern = rf'^{key}=.*'
            line = f"{key}={val}"
            return _re.sub(pattern, line, text, flags=_re.MULTILINE) if _re.search(pattern, text, _re.MULTILINE) else text + f"\n{line}"
        content = _set(content, "GATEWAY_URL",  gateway_url)
        content = _set(content, "REDIS_ADDR",   redis_addr)
        content = _set(content, "REDIS_HOSTS",  redis_hosts)
        # Add monitoring admin credentials if not already present (added in later installer version)
        if "MONITORING_ADMIN_PASSWORD" not in content:
            monitor_pw = secrets.token_urlsafe(24)
            content += f"\nMONITORING_ADMIN_USER=admin\nMONITORING_ADMIN_PASSWORD={monitor_pw}\n"
        env_file.write_text(content)
        run(["chmod", "600", str(env_file)])
        ok("  Monitoring .env: updated")
    else:
        grafana_pw   = secrets.token_urlsafe(24)
        commander_pw = secrets.token_urlsafe(24)
        monitor_pw   = secrets.token_urlsafe(24)
        content = (
            f"GATEWAY_URL={gateway_url}\n"
            f"GRAFANA_PASSWORD={grafana_pw}\n"
            f"REDIS_COMMANDER_USER=admin\n"
            f"REDIS_COMMANDER_PASSWORD={commander_pw}\n"
            f"MONITORING_ADMIN_USER=admin\n"
            f"MONITORING_ADMIN_PASSWORD={monitor_pw}\n"
            f"REDIS_ADDR={redis_addr}\n"
            f"REDIS_HOSTS={redis_hosts}\n"
        )
        write_file(str(env_file), content, mode="600")
        ok(f"  Monitoring .env: {env_file} (credentials generated)")


MONITORING_HTPASSWD = "/etc/nginx/monitoring.htpasswd"

def _write_monitoring_htpasswd():
    """Create/update the nginx htpasswd file for Prometheus and Alertmanager."""
    env_file = Path(MONITORING_DIR) / ".env"
    user, pw = "admin", ""
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("MONITORING_ADMIN_USER="):
                user = line.split("=", 1)[1].strip()
            elif line.startswith("MONITORING_ADMIN_PASSWORD="):
                pw = line.split("=", 1)[1].strip()
    if not pw:
        warn("  MONITORING_ADMIN_PASSWORD not set in .env — skipping htpasswd")
        return
    r = run(["openssl", "passwd", "-apr1", pw], capture=True, check=False)
    if r.returncode != 0:
        warn("  openssl not available — skipping htpasswd (Prometheus/Alertmanager will be unprotected)")
        return
    hashed = r.stdout.strip()
    write_file(MONITORING_HTPASSWD, f"{user}:{hashed}\n", mode="640")
    run(["chown", "root:www-data", MONITORING_HTPASSWD])
    ok(f"  Monitoring htpasswd: {MONITORING_HTPASSWD} (user: {user})")


def _sync_monitoring_files(entities):
    """Copy repo monitoring/ files to MONITORING_DIR and generate dynamic configs."""
    sd = script_dir() / "monitoring"
    dst = Path(MONITORING_DIR)

    # Copy the whole monitoring/ tree (docker-compose, loki, alertmanager, grafana, rules)
    for src_file, dst_name in [
        (sd / "docker-compose.yml",            "docker-compose.yml"),
        (sd / "loki" / "loki.yml",             "loki.yml"),
        (sd / "alertmanager" / "alertmanager.yml", "alertmanager.yml"),
        (sd / "prometheus" / "rules.yml",      "prometheus-rules.yml"),
        (sd / "promtail" / "promtail-systemd.yml", "promtail.yml"),
    ]:
        shutil.copy(src_file, dst / dst_name)

    # Grafana provisioning + dashboards
    grafana_src = sd / "grafana"
    grafana_dst = dst / "grafana"
    if grafana_src.is_dir():
        if grafana_dst.exists():
            shutil.rmtree(grafana_dst)
        shutil.copytree(grafana_src, grafana_dst)

    # prometheus.yml is generated dynamically (entity targets are site-specific)
    write_file(str(dst / "prometheus.yml"), _monitoring_prometheus_yml(entities))

    ok(f"  Monitoring configs synced to {MONITORING_DIR}")


def install_monitoring(entities, domain=None, nginx_port=None):
    """Install the Prometheus/Grafana/Loki monitoring stack via Docker Compose."""
    info(f"Installing monitoring stack to {MONITORING_DIR} ...")

    # Docker is required
    info("Checking Docker ..."); install_docker(); print()

    os.makedirs(MONITORING_DIR, exist_ok=True)

    # Read Redis password
    pass_file = Path(ENV_DIR) / "redis_pass"
    redis_pass = pass_file.read_text().strip() if pass_file.exists() else ""

    # .env — credentials + dynamic URLs (safe to re-run; preserves existing passwords)
    _write_monitoring_env(domain, redis_pass)

    # htpasswd for nginx basic auth on Prometheus and Alertmanager
    _write_monitoring_htpasswd()

    # Sync configs from repo (docker-compose.yml, loki, alertmanager, grafana, etc.)
    _sync_monitoring_files(entities)

    # Start the stack
    info("Starting monitoring stack ...")
    run(["docker", "compose", "up", "-d", "--pull", "missing"], cwd=MONITORING_DIR)
    ok("Monitoring stack started")

    # Force-sync Grafana admin password to .env value (GF_SECURITY_ADMIN_PASSWORD only
    # takes effect on first DB init; re-runs would leave the old password in the DB)
    env_file = Path(MONITORING_DIR) / ".env"
    grafana_pw = ""
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("GRAFANA_PASSWORD="):
                grafana_pw = line.split("=", 1)[1].strip()
    if grafana_pw:
        import time as _time
        _time.sleep(3)  # give Grafana a moment to finish starting
        r = run(["docker", "compose", "exec", "-T", "grafana",
                 "grafana", "cli", "admin", "reset-admin-password", grafana_pw],
                cwd=MONITORING_DIR, check=False, capture=True)
        if r.returncode == 0:
            ok("  Grafana admin password synced")
        else:
            warn("  Could not sync Grafana password — run manually if needed: mcp-admin monitoring reset-grafana-password")

    # Systemd unit to start monitoring on boot
    unit = (
        "[Unit]\n"
        "Description=SuiteCRM MCP Monitoring Stack\n"
        "Requires=docker.service\n"
        "After=docker.service\n\n"
        "[Service]\n"
        "Type=oneshot\n"
        "RemainAfterExit=yes\n"
        f"WorkingDirectory={MONITORING_DIR}\n"
        "ExecStart=/usr/bin/docker compose up -d\n"
        "ExecStop=/usr/bin/docker compose down\n"
        "TimeoutStartSec=120\n\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
    unit_path = f"/etc/systemd/system/{MONITORING_SVC_NAME}.service"
    write_file(unit_path, unit)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", MONITORING_SVC_NAME])
    ok(f"  Monitoring service: {unit_path} (enabled on boot)")

    _ip = _server_ip()
    print()
    if domain:
        base = f"https://{domain}"
        info("Monitoring UIs (via nginx):")
    elif nginx_port:
        base = f"http://{_ip}:{nginx_port}"
        info("Monitoring UIs (via nginx — accessible from any browser on the network):")
    else:
        base = None
        info("Monitoring UIs (direct ports — accessible from any browser on the network):")

    if base:
        print(f"  Grafana       : {base}/grafana/")
        print(f"  Prometheus    : {base}/prometheus/")
        print(f"  Alertmanager  : {base}/alertmanager/")
        print(f"  Redis UI      : {base}/redis/")
    else:
        print(f"  Grafana       : http://{_ip}:3001/")
        print(f"  Prometheus    : http://{_ip}:9090/")
        print(f"  Alertmanager  : http://{_ip}:9093/")
        print(f"  Redis UI      : http://{_ip}:8081/")
    print(f"  Credentials   : cat {MONITORING_DIR}/.env")
    print(f"                  Grafana/Redis: GRAFANA_PASSWORD, REDIS_COMMANDER_PASSWORD")
    print(f"                  Prometheus/Alertmanager: MONITORING_ADMIN_USER / MONITORING_ADMIN_PASSWORD")
    print()


def _monitoring_nginx_block():
    """Return nginx location blocks for the monitoring UIs."""
    return (
        "\n    # Monitoring UIs (installed by --monitoring)\n"
        # Grafana WebSocket (live streaming) — must come before the general /grafana/ block
        "    location /grafana/api/live/ {\n"
        "        proxy_pass http://127.0.0.1:3001/grafana/api/live/;\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Upgrade    $http_upgrade;\n"
        "        proxy_set_header Connection \"upgrade\";\n"
        "        proxy_set_header Host       $host;\n"
        "        proxy_read_timeout 3600s;\n"
        "    }\n"
        # Grafana serves under /grafana/ (GF_SERVER_SERVE_FROM_SUB_PATH=true)
        # so proxy_pass must preserve the /grafana/ prefix
        "    location /grafana/ {\n"
        "        proxy_pass http://127.0.0.1:3001/grafana/;\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host              $host;\n"
        "        proxy_set_header X-Real-IP         $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto https;\n"
        "        proxy_set_header Connection        \"\";\n"
        "        proxy_read_timeout 300s;\n"
        "        proxy_send_timeout 300s;\n"
        "        proxy_buffers      16 32k;\n"
        "        proxy_buffer_size  64k;\n"
        "    }\n"
        # Prometheus serves at / (--web.route-prefix=/) so strip /prometheus/ prefix
        "    location /prometheus/ {\n"
        f"        auth_basic \"SuiteCRM MCP Monitoring\";\n"
        f"        auth_basic_user_file {MONITORING_HTPASSWD};\n"
        "        proxy_pass http://127.0.0.1:9090/;\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host              $host;\n"
        "        proxy_set_header X-Real-IP         $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto https;\n"
        "        proxy_set_header Connection        \"\";\n"
        "        proxy_read_timeout 60s;\n"
        "    }\n"
        # Alertmanager serves at / (--web.route-prefix=/) so strip /alertmanager/ prefix
        "    location /alertmanager/ {\n"
        f"        auth_basic \"SuiteCRM MCP Monitoring\";\n"
        f"        auth_basic_user_file {MONITORING_HTPASSWD};\n"
        "        proxy_pass http://127.0.0.1:9093/;\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host              $host;\n"
        "        proxy_set_header X-Real-IP         $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto https;\n"
        "        proxy_set_header Connection        \"\";\n"
        "        proxy_read_timeout 60s;\n"
        "    }\n"
        # Redis Commander serves under /redis/ (URL_PREFIX=/redis)
        # so proxy_pass must preserve the /redis/ prefix
        "    location /redis/ {\n"
        "        proxy_pass http://127.0.0.1:8081/redis/;\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host              $host;\n"
        "        proxy_set_header X-Real-IP         $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto https;\n"
        "        proxy_read_timeout 30s;\n"
        "    }\n"
    )


def install_server():
    info(f"Installing server to {SERVER_DIR} ...")
    os.makedirs(SERVER_DIR, exist_ok=True)
    src  = script_dir() / "server" / "index.mjs"
    pkg  = script_dir() / "server" / "package.json"
    lock = script_dir() / "server" / "package-lock.json"
    if not src.exists():
        error("server/index.mjs not found. Run from the repo root directory.")
    shutil.copy(src, f"{SERVER_DIR}/index.mjs")
    shutil.copy(pkg, f"{SERVER_DIR}/package.json")
    if lock.exists():
        shutil.copy(lock, f"{SERVER_DIR}/package-lock.json")
    # Copy all additional modules required by index.mjs at runtime
    for extra in ("redis.mjs", "acl-check.mjs", "auth.mjs"):
        extra_src = script_dir() / "server" / extra
        if extra_src.exists():
            shutil.copy(extra_src, f"{SERVER_DIR}/{extra}")
    # Copy bridge modules (hybrid, legacy, graphql)
    bridges_src = script_dir() / "server" / "bridges"
    bridges_dst = Path(SERVER_DIR) / "bridges"
    if bridges_src.is_dir():
        if bridges_dst.exists():
            shutil.rmtree(bridges_dst)
        shutil.copytree(bridges_src, bridges_dst)
    # Copy admin scripts (migrate_profiles, etc.)
    scripts_src = script_dir() / "scripts"
    scripts_dst = Path(SERVER_DIR) / "scripts"
    if scripts_src.is_dir():
        if scripts_dst.exists():
            shutil.rmtree(scripts_dst)
        shutil.copytree(scripts_src, scripts_dst)
    lock_file = Path(SERVER_DIR) / "package-lock.json"
    if not lock_file.exists():
        error(f"package-lock.json not found in {SERVER_DIR}. Run 'npm install' in the repo first to generate it.")
    run(["npm", "ci", "--omit=dev", "--silent"], cwd=SERVER_DIR)
    ok("Server installed")

# ---------------------------------------------------------------------------
# Per-entity install
# ---------------------------------------------------------------------------

def install_entity(code, data, is_multi, oauth_cfg=None):
    """
    Install env file + systemd unit for one entity.
    is_multi=True: writes /etc/suitecrm-mcp/{code}.env, service suitecrm-mcp-{code}
    is_multi=False: writes /etc/suitecrm-mcp/gateway.env, service suitecrm-mcp
    oauth_cfg: dict of OAuth env vars written into the env file.
    """
    pass_file = Path(ENV_DIR) / "redis_pass"
    redis_pass = pass_file.read_text().strip() if pass_file.exists() else ""
    redis_url = f"redis://:{redis_pass}@127.0.0.1:6379" if redis_pass else "redis://127.0.0.1:6379"

    label    = data.get("label", code)
    endpoint = data["endpoint"]
    port     = data["port"]
    tls_skip = data.get("tls_skip", False)
    behind_proxy = is_multi or data.get("_behind_proxy", False)

    metrics_port = port + 6000
    if metrics_port > 65535:
        error(f"Entity port {port} too high: derived metrics port {metrics_port} exceeds 65535 (max entity port: 59535)")

    # GraphQL (v8) endpoints need OAuth2 client credentials
    is_graphql = "/graphql" in endpoint or "/api/graphql" in endpoint
    client_id     = data.get("client_id", "")
    client_secret = data.get("client_secret", "")
    auth_endpoint = data.get("auth_endpoint", "")
    if is_graphql:
        if not client_id:
            print()
            info(f"  [{code}] GraphQL API requires OAuth2 client credentials")
            client_id     = _prompt(f"  [{code}] SUITECRM_CLIENT_ID")
            client_secret = getpass.getpass(f"  [{code}] SUITECRM_CLIENT_SECRET: ").strip()
        if not auth_endpoint:
            # Derive: strip /api/graphql suffix, append /Api/access_token
            auth_endpoint = re.sub(r'/api/graphql.*$', '', endpoint, flags=re.IGNORECASE) + "/Api/access_token"
            info(f"  [{code}] Auth endpoint: {auth_endpoint}")

    if is_multi:
        env_path = f"{ENV_DIR}/{code}.env"
        svc_name = f"suitecrm-mcp-{code}"
        prefix   = f"suitecrm_{code}"
        lines = [
            f"# SuiteCRM MCP Gateway - {label}",
            f"SUITECRM_ENDPOINT={endpoint}",
            f"SUITECRM_PREFIX={prefix}",
            f"SUITECRM_CODE={code}",
            f"PORT={port}",
            "BIND_HOST=127.0.0.1",
            f"METRICS_PORT={metrics_port}",
            "METRICS_BIND=0.0.0.0",
            f"REDIS_URL={redis_url}",
            "NODE_NO_WARNINGS=1",
        ]
        if data.get("group"):
            lines.append(f"REQUIRED_GROUP={data['group']}")
    else:
        env_path = ENV_FILE
        svc_name = SVC_NAME
        prefix   = data.get("prefix", "suitecrm")
        lines = [
            f"# SuiteCRM MCP Gateway - {label}",
            f"SUITECRM_ENDPOINT={endpoint}",
            f"SUITECRM_PREFIX={prefix}",
            f"SUITECRM_CODE={code}",
            f"PORT={port}",
            "BIND_HOST=127.0.0.1",
            f"METRICS_PORT={metrics_port}",
            "METRICS_BIND=0.0.0.0",
            f"REDIS_URL={redis_url}",
            "NODE_NO_WARNINGS=1",
        ]
        if data.get("group"):
            lines.append(f"REQUIRED_GROUP={data['group']}")

    if tls_skip:
        warn(f"  [{code}] TLS verification disabled - only for self-signed certs on trusted networks")
        lines.append("NODE_TLS_REJECT_UNAUTHORIZED=0")
    if behind_proxy:
        lines.append("TRUST_PROXY=1")

    # v4 fallback endpoint when both v4 and v8 are configured
    if data.get("v4_endpoint"):
        lines.append(f"SUITECRM_V4_ENDPOINT={data['v4_endpoint']}")

    # GraphQL / SuiteCRM v8 API credentials
    if is_graphql and client_id:
        lines.append("")
        lines.append("# SuiteCRM v8 GraphQL OAuth2 credentials")
        lines.append(f"SUITECRM_API_VERSION=8")
        lines.append(f"SUITECRM_CLIENT_ID={client_id}")
        lines.append(f"SUITECRM_CLIENT_SECRET={client_secret}")
        lines.append(f"SUITECRM_AUTH_ENDPOINT={auth_endpoint}")

    # Auth0 vars needed by the entity gateway to validate session tokens
    if oauth_cfg:
        lines.append("")
        lines.append("# Auth0 (token validation)")
        for key in ("AUTH0_DOMAIN", "AUTH0_AUDIENCE", "OAUTH_GROUPS_CLAIM"):
            val = oauth_cfg.get(key)
            if val:
                lines.append(f"{key}={val}")

    lines.append("")

    write_file(env_path, "\n".join(lines), mode="600")
    run(["chown", f"{SVC_USER}:{SVC_USER}", env_path])
    ok(f"  Env: {env_path}")

    # Env directory permissions
    env_dir = str(Path(env_path).parent)
    run(["chmod", "700", env_dir])
    run(["chown", f"{SVC_USER}:{SVC_USER}", env_dir])

    # Systemd unit
    nb = node_bin()
    unit_path = f"/etc/systemd/system/{svc_name}.service"
    unit = (
        f"[Unit]\n"
        f"Description=SuiteCRM MCP Gateway - {label}\n"
        f"After=network.target\n\n"
        f"[Service]\n"
        f"Type=simple\n"
        f"User={SVC_USER}\n"
        f"Group={SVC_USER}\n"
        f"EnvironmentFile={env_path}\n"
        f"ExecStart={nb} {SERVER_DIR}/index.mjs\n"
        f"Restart=always\n"
        f"RestartSec=5\n"
        f"KillMode=control-group\n"
        f"StartLimitIntervalSec=120\n"
        f"StartLimitBurst=10\n"
        f"StandardOutput=journal\n"
        f"StandardError=journal\n"
        f"SyslogIdentifier={svc_name}\n"
        f"NoNewPrivileges=yes\n"
        f"PrivateTmp=yes\n"
        f"ProtectSystem=strict\n"
        f"ProtectHome=yes\n"
        f"ReadWritePaths=/etc/suitecrm-mcp /opt/suitecrm-mcp-server\n\n"
        f"[Install]\n"
        f"WantedBy=multi-user.target\n"
    )
    write_file(unit_path, unit)
    ok(f"  Service: {unit_path}")
    return svc_name

# ---------------------------------------------------------------------------
# nginx config generation
# ---------------------------------------------------------------------------

def _rebuild_nginx_multi(entities, domain=None, monitoring=False):
    """
    Write /etc/nginx/sites-available/suitecrm-mcp for multi-entity.
    DOMAIN_FILE is read as fallback if domain is None.
    NOTE: If ENV_DIR is manually deleted between runs, domain falls back to
    None and nginx is rebuilt with plain HTTP. This is intentional - DOMAIN_FILE
    persists the domain separately from ENV_DIR so it survives env resets.
    monitoring=True adds proxy locations for the monitoring UIs.
    """
    if domain is None and Path(DOMAIN_FILE).exists():
        domain = Path(DOMAIN_FILE).read_text().strip() or None
    if not monitoring:
        monitoring = Path(MONITORING_DIR).is_dir() and (Path(MONITORING_DIR) / "docker-compose.yml").exists()

    locations = ""
    for code, data in entities.items():
        port  = data["port"]
        label = data.get("label", code)
        locations += (
            f"\n    # {label} ({code})\n"
            f"    location = /{code}/messages {{\n"
            f"        access_log off;\n"
            f"        proxy_pass http://127.0.0.1:{port}/messages;\n"
            f"        proxy_http_version 1.1;\n"
            f"        proxy_set_header Connection '';\n"
            f"        proxy_set_header Host $host;\n"
            f"        proxy_pass_request_headers on;\n"
            f"        proxy_buffering off;\n"
            f"        proxy_cache off;\n"
            f"        proxy_read_timeout 3600s;\n"
            f"    }}\n"
            f"    location /{code}/ {{\n"
            f"        proxy_pass http://127.0.0.1:{port}/;\n"
            f"        proxy_http_version 1.1;\n"
            f"        proxy_set_header Connection '';\n"
            f"        proxy_set_header Host $host;\n"
            f"        proxy_pass_request_headers on;\n"
            f"        proxy_buffering off;\n"
            f"        proxy_cache off;\n"
            f"        proxy_read_timeout 3600s;\n"
            f"    }}\n"
        )

    # Auth routes served by the auth service (port 3100)
    auth_block = (
        f"\n    # OAuth2 auth routes - served by auth service (suitecrm-mcp-auth)\n"
        f"    location /auth/ {{\n"
        f"        proxy_pass http://127.0.0.1:3100/auth/;\n"
        f"        proxy_http_version 1.1;\n"
        f"        proxy_set_header Connection '';\n"
        f"        proxy_set_header Host $host;\n"
        f"        proxy_pass_request_headers on;\n"
        f"        proxy_buffering off;\n"
        f"        proxy_cache off;\n"
        f"        proxy_read_timeout 60s;\n"
        f"    }}\n"
        f"    location = / {{\n"
        f"        return 302 /auth/login;\n"
        f"    }}\n"
    )

    listen_line = (
        f"listen 80;\n    server_name {domain};"
        if domain else
        f"listen {NGINX_PORT};\n    server_name _;"
    )
    monitoring_block = _monitoring_nginx_block() if monitoring else ""
    conf = (
        f"# SuiteCRM MCP Gateway - generated by install.py\n"
        f"server {{\n"
        f"    {listen_line}\n"
        f"    large_client_header_buffers 4 32k;\n"
        f"    client_max_body_size 10m;\n"
        f"    access_log /var/log/nginx/suitecrm-mcp.access.log;\n"
        f"    error_log  /var/log/nginx/suitecrm-mcp.error.log;\n"
        f"    location /health {{\n"
        f"        default_type application/json;\n"
        f"        return 200 '{{\"gateway\":\"ok\",\"entities\":{len(entities)}}}';\n"
        f"    }}\n"
        f"{auth_block}"
        f"{monitoring_block}"
        f"{locations}}}\n"
    )
    write_file(NGINX_CONF, conf)
    _nginx_enable_and_reload()
    ok("nginx configured and reloaded")

def _nginx_single_tls(domain, port, monitoring=False):
    """Write HTTP-only nginx config for single-entity + certbot TLS."""
    if not monitoring:
        monitoring = Path(MONITORING_DIR).is_dir() and (Path(MONITORING_DIR) / "docker-compose.yml").exists()
    monitoring_block = _monitoring_nginx_block() if monitoring else ""
    conf = (
        f"server {{\n"
        f"    listen 80;\n"
        f"    server_name {domain};\n"
        f"    large_client_header_buffers 4 32k;\n"
        f"    client_max_body_size 10m;\n"
        f"    access_log /var/log/nginx/suitecrm-mcp.access.log;\n"
        f"    error_log  /var/log/nginx/suitecrm-mcp.error.log;\n\n"
        f"    location = /messages {{\n"
        f"        access_log off;\n"
        f"        proxy_pass http://127.0.0.1:{port}/messages;\n"
        f"        proxy_http_version 1.1;\n"
        f"        proxy_set_header Connection '';\n"
        f"        proxy_set_header Host $host;\n"
        f"        proxy_pass_request_headers on;\n"
        f"        proxy_buffering off;\n"
        f"        proxy_cache off;\n"
        f"        proxy_read_timeout 3600s;\n"
        f"    }}\n"
        f"{monitoring_block}"
        f"    location / {{\n"
        f"        proxy_pass http://127.0.0.1:{port};\n"
        f"        proxy_http_version 1.1;\n"
        f"        proxy_set_header Connection '';\n"
        f"        proxy_set_header Host $host;\n"
        f"        proxy_pass_request_headers on;\n"
        f"        proxy_buffering off;\n"
        f"        proxy_cache off;\n"
        f"        proxy_read_timeout 3600s;\n"
        f"    }}\n"
        f"}}\n"
    )
    write_file(NGINX_CONF, conf)
    _nginx_enable_and_reload()
    ok("nginx configured")

def _nginx_enable_and_reload():
    if not Path(NGINX_LINK).exists():
        os.symlink(NGINX_CONF, NGINX_LINK)
    default_site = "/etc/nginx/sites-enabled/default"
    if Path(default_site).exists():
        os.remove(default_site)
        warn("Removed nginx default site")
    run(["nginx", "-t"])
    run(["systemctl", "enable", "--now", "nginx"])
    run(["systemctl", "reload", "nginx"])

def _run_certbot(domain, email):
    r = run(
        ["certbot", "--nginx", "-d", domain,
         "--non-interactive", "--agree-tos", "-m", email, "--redirect"],
        check=False, capture=True
    )
    if r.returncode != 0:
        warn(f"certbot failed:\n{r.stderr.strip()}")
        warn("Gateway is running but HTTPS setup failed. Check:")
        warn(f"  - {domain} points to this server's public IP")
        warn("  - Port 80 is open (ACME challenge)")
        warn("  - Port 443 is open")
        warn(f"  Re-run manually: certbot --nginx -d {domain} -m {email} --agree-tos --redirect")
    else:
        ok(f"TLS certificate obtained for {domain}")
        ok("Auto-renewal configured via certbot systemd timer")

# ---------------------------------------------------------------------------
# apply_update_hardening - patches existing installs on --update
# ---------------------------------------------------------------------------

def apply_update_hardening(codes, is_multi):
    """
    Migrate existing installs to current hardening standard (User=, sandboxing,
    TRUST_PROXY, env dir permissions) without full reinstall.
    codes: iterable of entity codes (single: [SVC_NAME])
    """
    ensure_service_user()

    if Path(ENV_DIR).exists():
        run(["chmod", "700", ENV_DIR])
        run(["chown", f"{SVC_USER}:{SVC_USER}", ENV_DIR])

    for code in codes:
        if is_multi:
            env_path = Path(f"{ENV_DIR}/{code}.env")
            svc_file = Path(f"/etc/systemd/system/suitecrm-mcp-{code}.service")
            svc_name = f"suitecrm-mcp-{code}"
        else:
            env_path = Path(ENV_FILE)
            svc_file = Path(f"/etc/systemd/system/{SVC_NAME}.service")
            svc_name = SVC_NAME

        # Patch env: add TRUST_PROXY=1 if nginx is present and it is missing
        if env_path.exists():
            content = env_path.read_text()
            has_nginx = Path(NGINX_CONF).exists()
            if has_nginx and "TRUST_PROXY" not in content:
                env_path.write_text(content.rstrip("\n") + "\nTRUST_PROXY=1\n")
                run(["chown", f"{SVC_USER}:{SVC_USER}", str(env_path)])
                run(["chmod", "600", str(env_path)])
                ok(f"  [{code}] Added TRUST_PROXY=1")
            else:
                ok(f"  [{code}] Env: no changes needed")

        # Patch unit: inject User/Group and sandboxing if missing
        if svc_file.exists():
            unit = svc_file.read_text()
            changed = False
            if f"User={SVC_USER}" not in unit:
                unit = unit.replace(
                    "[Service]\n",
                    f"[Service]\nUser={SVC_USER}\nGroup={SVC_USER}\n"
                )
                changed = True
            if "NoNewPrivileges=yes" not in unit:
                unit = unit.replace(
                    "SyslogIdentifier=",
                    "NoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\n"
                    "ProtectHome=yes\nReadWritePaths=/etc/suitecrm-mcp /opt/suitecrm-mcp-server\n"
                    "SyslogIdentifier=",
                )
                changed = True
            # Migrate stale ExecStart paths from old install location
            if "/opt/suitecrm-mcp/index.mjs" in unit:
                unit = unit.replace("/opt/suitecrm-mcp/index.mjs", f"{SERVER_DIR}/index.mjs")
                changed = True
            if "/opt/suitecrm-mcp/auth.mjs" in unit:
                unit = unit.replace("/opt/suitecrm-mcp/auth.mjs", f"{SERVER_DIR}/auth.mjs")
                changed = True
            if changed:
                svc_file.write_text(unit)
                ok(f"  [{code}] Patched unit with hardening directives")
            else:
                ok(f"  [{code}] Unit: no changes needed")

    # Migrate auth service ExecStart path if stale
    auth_svc = Path(f"/etc/systemd/system/{AUTH_SVC_NAME}.service")
    if auth_svc.exists():
        unit = auth_svc.read_text()
        if "/opt/suitecrm-mcp/auth.mjs" in unit:
            unit = unit.replace("/opt/suitecrm-mcp/auth.mjs", f"{SERVER_DIR}/auth.mjs")
            auth_svc.write_text(unit)
            ok(f"  [auth] Migrated ExecStart path to {SERVER_DIR}/auth.mjs")

    # Sync REDIS_URL in all env files with the stored redis_pass
    pass_file = Path(ENV_DIR) / "redis_pass"
    if pass_file.exists():
        redis_pass = pass_file.read_text().strip()
        correct_url = f"redis://:{redis_pass}@127.0.0.1:6379" if redis_pass else "redis://127.0.0.1:6379"
        import re as _re
        env_files = list(Path(ENV_DIR).glob("*.env"))
        for env_file in env_files:
            content = env_file.read_text()
            new_content = _re.sub(r'REDIS_URL=redis://[^\n]*', f'REDIS_URL={correct_url}', content)
            if new_content != content:
                env_file.write_text(new_content)
                ok(f"  [{env_file.name}] Updated REDIS_URL with Redis password")

    # Fix Redis eviction policy from allkeys-lru to volatile-lru
    redis_conf = Path("/etc/redis/redis.conf")
    if redis_conf.exists():
        rc = redis_conf.read_text()
        if "allkeys-lru" in rc:
            rc = rc.replace("allkeys-lru", "volatile-lru")
            redis_conf.write_text(rc)
            run(["systemctl", "restart", "redis-server"])
            ok("Redis eviction policy updated to volatile-lru")

# ---------------------------------------------------------------------------
# Status display
# ---------------------------------------------------------------------------

def _get_running_entity_codes():
    r = run(
        ["systemctl", "list-units", "--no-legend", "--plain", "suitecrm-mcp-*"],
        capture=True, check=False
    )
    codes = []
    for line in r.stdout.splitlines():
        parts = line.split()
        if parts:
            svc = parts[0].replace("suitecrm-mcp-", "").replace(".service", "")
            codes.append(svc)
    return codes

def show_status_single(port=None):
    import urllib.request as _ur
    # Read port from env if not passed
    if port is None:
        port = 3101
        if Path(ENV_FILE).exists():
            with open(ENV_FILE) as f:
                for line in f:
                    if line.startswith("PORT="):
                        try: port = int(line.split("=")[1].strip())
                        except: pass

    r = run(["systemctl", "is-active", SVC_NAME], check=False, capture=True)
    active = r.stdout.strip() == "active"
    status_str = f"{GREEN}active{NC}" if active else f"{RED}inactive{NC}"

    print()
    info("=" * 56)
    info("SUITECRM MCP GATEWAY STATUS")
    info("=" * 56)
    print(f"  service : {status_str}")
    print(f"  health  : http://127.0.0.1:{port}/health")
    print(f"  sse     : http://127.0.0.1:{port}/sse")
    print(f"  test    : http://127.0.0.1:{port}/test")
    if active:
        try:
            with _ur.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                d = json.loads(resp.read())
                print(f"  conns   : {d.get('connections', 0)} active")
        except Exception:
            print(f"  health  : {YELLOW}unreachable{NC}")
    print()

def show_status_multi(entities=None):
    import urllib.request as _ur
    print()
    info("=" * 60)
    info("SUITECRM MCP GATEWAY STATUS")
    info("=" * 60)

    if entities is None:
        running = _get_running_entity_codes()
        entities = {code: {"label": code, "port": None} for code in running}
        for code in running:
            env_path = Path(f"{ENV_DIR}/{code}.env")
            if env_path.exists():
                with open(env_path) as f:
                    for line in f:
                        if line.startswith("PORT="):
                            try: entities[code]["port"] = int(line.split("=")[1].strip())
                            except: pass

    saved_domain = Path(DOMAIN_FILE).read_text().strip() if Path(DOMAIN_FILE).exists() else None

    for code, data in entities.items():
        svc = f"suitecrm-mcp-{code}"
        label = data.get("label", code)
        port  = data.get("port")
        r = run(["systemctl", "is-active", svc], check=False, capture=True)
        active = r.stdout.strip() == "active"
        status_str = f"{GREEN}active{NC}" if active else f"{RED}inactive{NC}"
        print(f"\n  [{code}] {label}")
        print(f"  status  : {status_str}")
        if port:
            print(f"  local   : http://127.0.0.1:{port}/health")
            if saved_domain:
                print(f"  external: https://{saved_domain}/{code}/sse")
            else:
                print(f"  external: http://{_server_ip()}:{NGINX_PORT}/{code}/sse")
            if active:
                try:
                    with _ur.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                        d = json.loads(resp.read())
                        print(f"  conns   : {d.get('connections', 0)} active")
                except Exception:
                    print(f"  health  : {YELLOW}unreachable{NC}")
    print()

# ---------------------------------------------------------------------------
# Remove entity (multi)
# ---------------------------------------------------------------------------

def remove_entity(code):
    svc = f"suitecrm-mcp-{code}"
    run(["systemctl", "stop", svc], check=False)
    run(["systemctl", "disable", svc], check=False)
    for path in [f"/etc/systemd/system/{svc}.service", f"{ENV_DIR}/{code}.env"]:
        if Path(path).exists():
            os.remove(path)
            ok(f"  Removed: {path}")
    run(["systemctl", "daemon-reload"])
    ok(f"Entity '{code}' removed")

# ---------------------------------------------------------------------------
# Uninstall (single)
# ---------------------------------------------------------------------------

def uninstall_single():
    warn("This will stop and remove the SuiteCRM MCP gateway.")
    if input("  Type 'yes' to confirm: ").strip().lower() != "yes":
        info("Aborted."); sys.exit(0)
    for svc in [SVC_NAME, AUTH_SVC_NAME]:
        run(["systemctl", "stop", svc], check=False)
        run(["systemctl", "disable", svc], check=False)
    for path in [
        f"/etc/systemd/system/{SVC_NAME}.service",
        f"/etc/systemd/system/{AUTH_SVC_NAME}.service",
        ENV_FILE, AUTH_ENV_FILE, ENV_DIR, SERVER_DIR, NGINX_LINK, NGINX_CONF
    ]:
        if Path(path).exists():
            if Path(path).is_dir(): shutil.rmtree(path)
            else: os.remove(path)
            ok(f"Removed: {path}")
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "reload", "nginx"], check=False)
    ok("Uninstalled.")

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="SuiteCRM MCP Gateway - Unified Installer"
    )
    # Config source
    parser.add_argument("config_pos", nargs="?", metavar="CONFIG",
                        help="Path to entities.json (positional)")
    parser.add_argument("--config", default="entities.json",
                        help="Path to entities.json (default: entities.json)")
    # Single-entity CLI flags
    parser.add_argument("--url",    help="CRM base URL or full rest.php endpoint (single-entity mode)")
    parser.add_argument("--code",   default="suitecrm", help="Entity code (with --url, default: suitecrm)")
    parser.add_argument("--label",  default="My CRM",   help="Service description (with --url)")
    parser.add_argument("--port",   type=int, default=3101, help="Listen port (single entity, default: 3101)")
    parser.add_argument("--prefix", default="suitecrm", help="Tool name prefix (single entity, default: suitecrm)")
    parser.add_argument("--tls-skip", action="store_true", help="Disable TLS cert verification")
    # HTTPS
    parser.add_argument("--domain", help="Domain for HTTPS via Let's Encrypt")
    parser.add_argument("--email",  help="Email for Let's Encrypt cert (required with --domain)")
    # OAuth2/OIDC (non-interactive use; installer will prompt if omitted)
    parser.add_argument("--oauth-issuer",       dest="oauth_issuer",       help="OIDC issuer URL")
    parser.add_argument("--oauth-client-id",    dest="oauth_client_id",    help="OAuth client ID")
    parser.add_argument("--oauth-client-secret",dest="oauth_client_secret",help="OAuth client secret")
    parser.add_argument("--oauth-audience",     dest="oauth_audience",     help="OAuth audience")
    parser.add_argument("--oauth-groups-claim", dest="oauth_groups_claim", default=None,
                        help="JWT claim for groups (default: AUTH0_AUDIENCE + '/groups')")
    parser.add_argument("--gateway-url",        dest="gateway_url",        help="Gateway external URL (e.g. https://mcp.yourcompany.com)")
    parser.add_argument("--skip-oauth",         dest="skip_oauth", action="store_true",
                        help="Skip OAuth setup (for upgrades where OAuth is already configured)")
    # Operations
    parser.add_argument("--add",        action="store_true", help="Add new entities only (multi)")
    parser.add_argument("--remove",     nargs="+", metavar="CODE", help="Remove entity codes (multi)")
    parser.add_argument("--status",     action="store_true", help="Show status")
    parser.add_argument("--update",     action="store_true", help="Update server code and restart")
    parser.add_argument("--uninstall",  action="store_true", help="Remove single-entity install")
    parser.add_argument("--monitoring", action="store_true",
                        help="Install Prometheus/Grafana/Loki monitoring stack via Docker")
    parser.add_argument("--monitoring-only", dest="monitoring_only", action="store_true",
                        help="Reinstall/update monitoring stack only — skips all CRM service steps")
    parser.add_argument("--setup-crm-host", dest="setup_crm_host", metavar="CODE",
                        help="Deploy provision script to CRM VM for entity CODE")
    args = parser.parse_args()

    # Validate auth/domain flags before anything else
    if args.domain and not args.email:
        error("--email is required when --domain is set (needed for Let's Encrypt)")
    if args.domain: validate_domain(args.domain)
    if args.email:  validate_email(args.email)
    if args.remove:
        for c in args.remove: validate_code(c)
    if args.url:
        validate_code(args.code)

    if os.geteuid() != 0:
        error("Run as root (sudo)")

    # Determine effective config path (positional wins over --config)
    config_path = args.config_pos or args.config

    # -----------------------------------------------------------------------
    # Determine mode: single vs multi
    # -----------------------------------------------------------------------
    # --url flag = explicit single-entity CLI mode
    # positional/--config pointing at a file with 2+ entities = multi
    # positional/--config with 1 entity = single (no nginx unless --domain)
    # no args at all + no entities.json = interactive

    if args.status:
        # Auto-detect mode from running services
        running = _get_running_entity_codes()
        if running:
            show_status_multi()
        else:
            show_status_single()
        sys.exit(0)

    if args.uninstall:
        uninstall_single(); sys.exit(0)

    if args.monitoring_only:
        # Load entities from existing config so nginx and prometheus.yml stay correct
        # Prefer the installed runtime path; fall back to the CLI-supplied config path
        entities_file = Path(ENTITIES_JSON) if Path(ENTITIES_JSON).exists() else Path(config_path)
        if not entities_file.exists():
            error(f"No entities config found at {ENTITIES_JSON} or {config_path}.\n"
                  "Run the full installer first, or pass --config <path>.")
        with open(entities_file) as f:
            entities = json.load(f)
        saved_domain = Path(DOMAIN_FILE).read_text().strip() if Path(DOMAIN_FILE).exists() else None
        print(); info("=" * 60); info("MONITORING STACK"); info("=" * 60); print()
        install_monitoring(entities, domain=saved_domain, nginx_port=NGINX_PORT if not saved_domain else None)
        if saved_domain:
            info("Updating nginx with monitoring locations ...")
            _rebuild_nginx_multi(entities, domain=saved_domain, monitoring=True); print()
        elif Path("/etc/nginx/sites-available/suitecrm-mcp").exists():
            info("Updating nginx with monitoring locations ...")
            _rebuild_nginx_multi(entities, domain=None, monitoring=True); print()
        print()
        info("=" * 60); ok("MONITORING REINSTALL COMPLETE"); info("=" * 60)
        print()
        sys.exit(0)

    if args.setup_crm_host:
        validate_code(args.setup_crm_host)
        if not Path(CRM_HOSTS_FILE).exists():
            error(f"No SSH provisioning config found at {CRM_HOSTS_FILE}.\n"
                  "Run install.py first and enable SSH provisioning when prompted.")
        with open(CRM_HOSTS_FILE) as f:
            crm_hosts = json.load(f)
        code = args.setup_crm_host
        if code not in crm_hosts:
            avail = ", ".join(crm_hosts.keys()) or "none configured"
            error(f"Entity '{code}' not in {CRM_HOSTS_FILE}. Available: {avail}")
        print()
        info(f"Deploying provision script for entity '{code}' ...")
        if not setup_crm_host(code, crm_hosts[code]):
            error("Deployment failed - check SSH access and key path above")
        # Persist command built by setup_crm_host (SUITECRM_CONFIG auto-detected)
        write_crm_hosts(crm_hosts)
        sys.exit(0)

    # --url: pure single-entity CLI mode
    if args.url:
        is_multi = False
        url = args.url
        if "rest.php" in url:
            endpoint = url
            version  = None
        else:
            info("Auto-detecting REST API endpoint ...")
            endpoint, version = auto_detect_endpoint(url, verbose=True)
            if not endpoint:
                error("Could not auto-detect endpoint. "
                      "Pass the full rest.php URL directly with --url.")
        entities = {
            args.code: {
                "label":    args.label,
                "endpoint": endpoint,
                "port":     args.port,
                "tls_skip": args.tls_skip,
                "prefix":   args.prefix,
            }
        }

    elif Path(config_path).exists():
        entities = load_entities(config_path)
        is_multi = len(entities) > 1

    else:
        # Interactive
        entities = interactive_setup()
        is_multi = len(entities) > 1

    # -----------------------------------------------------------------------
    # --status (late, now we have entities)
    # -----------------------------------------------------------------------

    if args.update:
        print(); info("=" * 60); info("UPDATE MODE"); info("=" * 60); print()
        install_server(); print()
        info("Installing admin tool ..."); install_profile_admin(); print()
        info("Applying hardening to existing installs ...")
        codes = list(entities.keys()) if is_multi else [SVC_NAME]
        apply_update_hardening(codes, is_multi); print()
        run(["systemctl", "daemon-reload"])
        if is_multi:
            for code in entities:
                run(["systemctl", "restart", f"suitecrm-mcp-{code}"], check=False)
                ok(f"  Restarted: suitecrm-mcp-{code}")
            show_status_multi(entities)
        else:
            run(["systemctl", "restart", SVC_NAME])
            ok(f"Restarted: {SVC_NAME}")
            show_status_single(args.port)
        # Refresh monitoring configs if monitoring is installed
        if (Path(MONITORING_DIR) / "docker-compose.yml").exists():
            print(); info("Refreshing monitoring configs ...")
            saved_domain = Path(DOMAIN_FILE).read_text().strip() if Path(DOMAIN_FILE).exists() else None
            pass_file = Path(ENV_DIR) / "redis_pass"
            redis_pass = pass_file.read_text().strip() if pass_file.exists() else ""
            _write_monitoring_env(saved_domain, redis_pass)
            _sync_monitoring_files(entities)
            run(["docker", "compose", "up", "-d", "--pull", "missing"], cwd=MONITORING_DIR)
            ok("Monitoring stack updated and restarted")
        sys.exit(0)

    # -----------------------------------------------------------------------
    # --remove (multi)
    # -----------------------------------------------------------------------
    if args.remove:
        warn(f"Removing entities: {', '.join(args.remove)}")
        if input("  Type 'yes' to confirm: ").strip().lower() != "yes":
            info("Aborted."); sys.exit(0)
        for code in args.remove:
            remove_entity(code)
        remaining = {c: d for c, d in entities.items() if c not in args.remove}
        if remaining:
            info("Rebuilding nginx for remaining entities ...")
            _rebuild_nginx_multi(remaining)
        else:
            info("No entities remain - removing nginx config ...")
            for path in [NGINX_LINK, NGINX_CONF]:
                if Path(path).exists():
                    os.remove(path)
                    ok(f"Removed: {path}")
            run(["systemctl", "reload", "nginx"], check=False)
        sys.exit(0)

    # -----------------------------------------------------------------------
    # Fresh install / --add
    # -----------------------------------------------------------------------
    print()
    if is_multi:
        info("=" * 60); info("SUITECRM MCP GATEWAY - MULTI-ENTITY INSTALLER"); info("=" * 60)
        info(f"Entities: {', '.join(entities.keys())}"); print()
    else:
        info("=" * 56); info("SUITECRM MCP GATEWAY - SINGLE ENTITY INSTALLER"); info("=" * 56); print()

    # Determine which entities to install (--add skips already-running ones)
    if is_multi and args.add:
        running = set(_get_running_entity_codes())
        to_install = {c: d for c, d in entities.items() if c not in running}
        if not to_install:
            info("No new entities to add - all are already installed.")
            sys.exit(0)
        info(f"Adding: {', '.join(to_install.keys())}")
    else:
        to_install = entities

    # Node.js
    info("Checking Node.js ..."); install_node(); print()

    # Redis
    info("Checking Redis ..."); install_redis(); print()

    # nginx (multi always; single only when --domain)
    if is_multi or args.domain:
        info("Checking nginx ..."); install_nginx(); print()

    # Service user
    info("Ensuring service user ..."); ensure_service_user(); print()

    # Server code
    info("Installing server ..."); install_server(); print()

    # Admin tool
    info("Installing admin tool ..."); install_profile_admin(); print()

    # Env dir
    os.makedirs(ENV_DIR, exist_ok=True)
    run(["chmod", "700", ENV_DIR])
    run(["chown", f"{SVC_USER}:{SVC_USER}", ENV_DIR])

    # OAuth2 config
    oauth_cfg = None
    if not getattr(args, "skip_oauth", False):
        oauth_cfg = prompt_oauth_config(args, domain=args.domain)

    # Write /etc/suitecrm-mcp/entities.json for the server to read at runtime
    info("Writing entities config ...")
    write_entities_json(entities)
    print()

    # SSH provisioning config
    crm_hosts = prompt_ssh_provisioning(to_install)
    if crm_hosts:
        # Merge with any existing entries so --add mode doesn't drop other entities
        if Path(CRM_HOSTS_FILE).exists():
            try:
                existing_hosts = json.loads(Path(CRM_HOSTS_FILE).read_text())
                existing_hosts.update(crm_hosts)
                crm_hosts = existing_hosts
            except Exception:
                pass
        info("Writing SSH provisioning config ...")
        write_crm_hosts(crm_hosts)
        print()
        deploy_now = input("  Deploy provision script to CRM VMs now? [Y/n]: ").strip().lower()
        if deploy_now in ("", "y", "yes"):
            print()
            for code, host_cfg in crm_hosts.items():
                ok_deploy = setup_crm_host(code, host_cfg)
                if not ok_deploy:
                    warn(f"  Re-run later: sudo python3 install.py --setup-crm-host {code}")
            # Persist commands built by setup_crm_host (SUITECRM_CONFIG auto-detected)
            write_crm_hosts(crm_hosts)
        else:
            warn("  SSH provisioning config saved but provision script NOT yet deployed.")
            warn("  Auto-provisioning will fail until you run:")
            for code in crm_hosts:
                warn(f"    sudo python3 install.py --setup-crm-host {code}")
        print()

    # Auth service
    if oauth_cfg:
        info("Installing auth service ...")
        install_auth_service(oauth_cfg)
        print()

    # Per-entity install
    info("Installing env files and services ...")
    svc_names = []
    for code, data in to_install.items():
        # Inject behind_proxy flag for single+domain case
        if not is_multi and args.domain:
            data = dict(data, _behind_proxy=True)
        svc_name = install_entity(code, data, is_multi, oauth_cfg=oauth_cfg)
        svc_names.append((code, svc_name))

    run(["systemctl", "daemon-reload"])
    if oauth_cfg:
        run(["systemctl", "enable", "--now", AUTH_SVC_NAME])
        ok(f"  Started: {AUTH_SVC_NAME}")
    for code, svc_name in svc_names:
        run(["systemctl", "enable", "--now", svc_name])
        ok(f"  Started: {svc_name}")
    print()

    # Offer monitoring interactively if not already decided by flag
    do_monitoring = getattr(args, "monitoring", False)
    if not do_monitoring and not getattr(args, "add", False):
        print()
        m_ans = input("  Install monitoring stack (Prometheus/Grafana/Loki)? [y/N]: ").strip().lower()
        do_monitoring = m_ans in ("y", "yes")

    # nginx config
    if is_multi:
        info("Configuring nginx ...")
        _rebuild_nginx_multi(entities, domain=args.domain, monitoring=do_monitoring); print()
    elif args.domain:
        port = list(to_install.values())[0]["port"]
        info("Configuring nginx (TLS terminator) ...")
        _nginx_single_tls(args.domain, port, monitoring=do_monitoring); print()

    # certbot
    if args.domain:
        os.makedirs(ENV_DIR, exist_ok=True)
        Path(DOMAIN_FILE).write_text(args.domain)
        info("Setting up HTTPS ...")
        install_certbot()
        _run_certbot(args.domain, args.email); print()

    # Monitoring stack
    if do_monitoring:
        print(); info("=" * 60); info("MONITORING STACK"); info("=" * 60); print()
        install_monitoring(entities, domain=args.domain, nginx_port=NGINX_PORT if is_multi else None)
        # Rebuild nginx to include monitoring locations if nginx is already configured
        if is_multi:
            info("Updating nginx with monitoring locations ...")
            _rebuild_nginx_multi(entities, domain=args.domain, monitoring=True); print()
        elif args.domain:
            port = list(to_install.values())[0]["port"]
            _nginx_single_tls(args.domain, port, monitoring=True); print()

    # Status + connect info
    if is_multi:
        show_status_multi(entities)
        if args.domain:
            print(f"  Connect at: https://{args.domain}/<code>/sse")
        else:
            print(f"  Connect at: http://{_server_ip()}:{NGINX_PORT}/<code>/sse")
    else:
        port = list(to_install.values())[0]["port"]
        show_status_single(port)
        if args.domain:
            print(f"  SSE endpoint: https://{args.domain}/sse")
        else:
            print(f"  SSE endpoint: http://{_server_ip()}:{port}/sse")

    print()
    if oauth_cfg:
        gw_url = oauth_cfg.get("GATEWAY_PUBLIC_URL", "https://YOUR_GATEWAY")
        info("Users authenticate by visiting:")
        print(f"  {gw_url}/auth/login")
        print()
        info("After login they receive an API key to use with Claude Desktop,")
        info("Claude Code, or OpenClaw. See README.md for connection examples.")
    else:
        info("See README.md for connection and authentication instructions.")

    print()
    print(f"{GREEN}{'=' * 60}{NC}")
    ok("INSTALLATION COMPLETE")
    print(f"{GREEN}{'=' * 60}{NC}")
    print()


if __name__ == "__main__":
    main()
