#!/usr/bin/env python3
"""
SuiteCRM MCP Gateway - Multi-Entity Installer
==============================================
Installs N gateway instances (one per CRM entity) behind nginx.
Each entity gets its own systemd service and port.
Nginx routes /code/sse and /code/messages to the right process.

Usage:
  sudo python3 install-multi.py                          # install from entities.json
  sudo python3 install-multi.py --config /path/to/entities.json
  sudo python3 install-multi.py --add                   # add new entities from config
  sudo python3 install-multi.py --remove crm1 crm2     # remove specific entities
  sudo python3 install-multi.py --status                # show all entity status
  sudo python3 install-multi.py --update                # update server code + restart all
  sudo python3 install-multi.py --domain mcp.example.com --email you@example.com  # enable HTTPS

entities.json format:
  {
    "crm1": {
      "label": "Main CRM",
      "endpoint": "https://crm.example.com/service/v4_1/rest.php",
      "port": 3101
    },
    "crm2": {
      "label": "Client B CRM",
      "endpoint": "https://crm.clientb.com/service/v4_1/rest.php",
      "port": 3102,
      "tls_skip": true
    }
  }

After install, connect at: http://YOUR_SERVER:8080/<code>/sse
"""

import os, sys, subprocess, json, argparse, shutil, re
from pathlib import Path

SERVER_DIR   = "/opt/suitecrm-mcp"
ENV_DIR      = "/etc/suitecrm-mcp"
DOMAIN_FILE  = "/etc/suitecrm-mcp/domain"
NGINX_CONF   = "/etc/nginx/sites-available/suitecrm-mcp"
NGINX_LINK   = "/etc/nginx/sites-enabled/suitecrm-mcp"
NGINX_PORT   = 8080

RED = "\033[0;31m"; GREEN = "\033[0;32m"; YELLOW = "\033[1;33m"; CYAN = "\033[0;36m"; NC = "\033[0m"
def info(m): print(f"{CYAN}[INFO]{NC} {m}")
def ok(m):   print(f"{GREEN}[OK]{NC} {m}")
def warn(m): print(f"{YELLOW}[WARN]{NC} {m}")
def error(m): print(f"{RED}[ERROR]{NC} {m}"); sys.exit(1)

SAFE_DOMAIN_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9.-]+$')
SAFE_EMAIL_RE  = re.compile(r'^[^@\s,;|&<>]+@[^@\s,;|&<>]+\.[^@\s,;|&<>]+$')
SAFE_CODE_RE   = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$')

def validate_domain(d):
    if not SAFE_DOMAIN_RE.match(d):
        error(f"Invalid domain: {d!r} - must contain only letters, digits, hyphens, and dots")

def validate_email(e):
    if not SAFE_EMAIL_RE.match(e):
        error(f"Invalid email address: {e!r}")

def validate_code(c):
    if not SAFE_CODE_RE.match(c):
        error(f"Invalid entity code: {c!r} - must contain only letters, digits, hyphens, and underscores")

def run(cmd, check=True, capture=False, cwd=None):
    # String commands are only used for unavoidable shell pipelines (e.g. curl | bash).
    # All privileged paths use list form to avoid shell injection.
    if isinstance(cmd, str): cmd = ["bash", "-c", cmd]
    r = subprocess.run(cmd, capture_output=capture, text=True, cwd=cwd)
    if check and r.returncode != 0:
        error(f"Command failed: {' '.join(cmd)}\n{r.stderr.strip() if capture else ''}")
    return r

def write_file(path, content, mode=None):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f: f.write(content)
    if mode: run(["chmod", mode, path])

def node_bin():
    return shutil.which("node") or "/usr/bin/node"

def script_dir():
    return Path(__file__).parent.resolve()

def load_entities(config_path):
    p = Path(config_path)
    if not p.exists():
        error(f"Config file not found: {config_path}\nCopy entities.example.json to entities.json and fill it in.")
    with open(p) as f:
        try: entities = json.load(f)
        except json.JSONDecodeError as e: error(f"Invalid JSON in {config_path}: {e}")

    # Validate
    ports_seen = {}
    for code, data in entities.items():
        if not re.match(r'^[a-zA-Z0-9_-]+$', code):
            error(f"Entity code '{code}' must contain only letters, numbers, hyphens, and underscores")
        if "endpoint" not in data:
            error(f"Entity '{code}' missing required field: endpoint")
        if "port" not in data:
            error(f"Entity '{code}' missing required field: port")
        port = data["port"]
        if port in ports_seen:
            error(f"Port {port} used by both '{code}' and '{ports_seen[port]}' - each entity needs a unique port")
        ports_seen[port] = code

    return entities

def check_deps():
    info("Checking dependencies...")
    if not shutil.which("node"):
        info("Installing Node.js LTS...")
        run("curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -")  # shell pipeline - no list form possible
        run(["apt-get", "install", "-y", "nodejs"])
        ok(f"Node.js installed: {run(['node', '--version'], capture=True).stdout.strip()}")
    else:
        ok(f"Node.js: {run(['node', '--version'], capture=True).stdout.strip()}")
    if not shutil.which("nginx"):
        info("Installing nginx...")
        run(["apt-get", "update", "-qq"])
        run(["apt-get", "install", "-y", "nginx"])
        ok("nginx installed")
    else:
        ok("nginx: present")

def install_server():
    info(f"Installing shared server to {SERVER_DIR} ...")
    os.makedirs(SERVER_DIR, exist_ok=True)
    src = script_dir() / "server" / "index.mjs"
    pkg = script_dir() / "server" / "package.json"
    if not src.exists():
        error(f"server/index.mjs not found. Run from the repo root directory.")
    lockfile = script_dir() / "server" / "package-lock.json"
    shutil.copy(src, f"{SERVER_DIR}/index.mjs")
    shutil.copy(pkg, f"{SERVER_DIR}/package.json")
    if lockfile.exists():
        shutil.copy(lockfile, f"{SERVER_DIR}/package-lock.json")
    run(["npm", "ci", "--omit=dev", "--silent"], cwd=SERVER_DIR)
    ok("Server installed")

def install_env_for(code, data):
    label    = data.get("label", code)
    endpoint = data["endpoint"]
    port     = data["port"]
    tls_skip = data.get("tls_skip", False)

    lines = [
        f"# SuiteCRM MCP Gateway - {label}",
        f"SUITECRM_ENDPOINT={endpoint}",
        f"SUITECRM_PREFIX=suitecrm_{code}",
        f"SUITECRM_CODE={code}",
        f"PORT={port}",
        "NODE_NO_WARNINGS=1",
    ]
    if tls_skip:
        warn(f"  [{code}] TLS verification disabled - only for self-signed certs on trusted networks")
        lines.append("NODE_TLS_REJECT_UNAUTHORIZED=0")
    lines.append("")
    path = f"{ENV_DIR}/{code}.env"
    write_file(path, "\n".join(lines), mode="600")
    ok(f"  Env: {path}")

def install_service_for(code, label):
    nb = node_bin()
    svc = f"suitecrm-mcp-{code}"
    content = (
        f"[Unit]\n"
        f"Description=SuiteCRM MCP Gateway - {label}\n"
        f"After=network.target\n\n"
        f"[Service]\n"
        f"Type=simple\n"
        f"EnvironmentFile={ENV_DIR}/{code}.env\n"
        f"ExecStart={nb} {SERVER_DIR}/index.mjs\n"
        f"Restart=always\n"
        f"RestartSec=5\n"
        f"StandardOutput=journal\n"
        f"StandardError=journal\n"
        f"SyslogIdentifier={svc}\n\n"
        f"[Install]\n"
        f"WantedBy=multi-user.target\n"
    )
    write_file(f"/etc/systemd/system/{svc}.service", content)
    ok(f"  Service: /etc/systemd/system/{svc}.service")

def install_certbot():
    if not shutil.which("certbot"):
        info("Installing certbot...")
        run(["apt-get", "install", "-y", "certbot", "python3-certbot-nginx"])
        ok("certbot installed")
    else:
        ok("certbot: present")


def rebuild_nginx(entities, domain=None):
    # DOMAIN_FILE is written by the --domain install path and lives in ENV_DIR.
    # If ENV_DIR is manually deleted between runs, domain will be None here and
    # nginx will be (re)built with plain HTTP. Low risk in practice, but if HTTPS
    # silently disappears after a manual cleanup, this is why.
    if domain is None and Path(DOMAIN_FILE).exists():
        domain = Path(DOMAIN_FILE).read_text().strip() or None
    locations = ""
    for code, data in entities.items():
        port  = data["port"]
        label = data.get("label", code)
        locations += f"""
    # {label} ({code})
    location = /{code}/messages {{
        access_log off;
        proxy_pass http://127.0.0.1:{port}/messages;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_pass_request_headers on;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }}
    location /{code}/ {{
        proxy_pass http://127.0.0.1:{port}/;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_pass_request_headers on;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }}
"""
    listen_line   = f"listen 80;\n    server_name {domain};" if domain else f"listen {NGINX_PORT};\n    server_name _;"
    conf = f"""# SuiteCRM MCP Gateway - generated by install-multi.py
server {{
    {listen_line}
    large_client_header_buffers 4 32k;
    client_max_body_size 10m;
    access_log /var/log/nginx/suitecrm-mcp.access.log;
    error_log /var/log/nginx/suitecrm-mcp.error.log;
    location /health {{
        default_type application/json;
        return 200 '{{"gateway":"ok","entities":{len(entities)}}}';
    }}
{locations}
}}
"""
    write_file(NGINX_CONF, conf)
    if not Path(NGINX_LINK).exists():
        os.symlink(NGINX_CONF, NGINX_LINK)
    default = "/etc/nginx/sites-enabled/default"
    if Path(default).exists():
        os.remove(default)
        warn("Removed nginx default site")
    run(["nginx", "-t"])
    run(["systemctl", "enable", "--now", "nginx"])
    run(["systemctl", "reload", "nginx"])
    ok("nginx configured and reloaded")

def get_running_entities():
    """Return list of entity codes with active systemd services."""
    r = run(["systemctl", "list-units", "--no-legend", "--plain", "suitecrm-mcp-*"], capture=True, check=False)
    codes = []
    for line in r.stdout.splitlines():
        parts = line.split()
        if parts:
            svc = parts[0].replace("suitecrm-mcp-", "").replace(".service", "")
            codes.append(svc)
    return codes

def show_status(entities=None):
    import urllib.request
    print()
    info("=" * 60)
    info("SUITECRM MCP GATEWAY STATUS")
    info("=" * 60)

    # Discover running services if entities not provided
    if entities is None:
        running = get_running_entities()
        entities = {code: {"label": code, "port": None} for code in running}
        # Try to get ports from env files
        for code in running:
            env_path = Path(f"{ENV_DIR}/{code}.env")
            if env_path.exists():
                with open(env_path) as f:
                    for line in f:
                        if line.startswith("PORT="):
                            try: entities[code]["port"] = int(line.split("=")[1].strip())
                            except: pass

    for code, data in entities.items():
        svc = f"suitecrm-mcp-{code}"
        label = data.get("label", code)
        port = data.get("port")
        r = run(["systemctl", "is-active", svc], check=False, capture=True)
        active = r.stdout.strip() == "active"
        status_str = f"{GREEN}active{NC}" if active else f"{RED}inactive{NC}"
        print(f"\n  [{code}] {label}")
        print(f"  status   : {status_str}")
        if port:
            print(f"  local    : http://127.0.0.1:{port}/health")
            saved_domain = Path(DOMAIN_FILE).read_text().strip() if Path(DOMAIN_FILE).exists() else None
            if saved_domain:
                print(f"  external : https://{saved_domain}/{code}/sse")
            else:
                print(f"  external : http://YOUR_SERVER:{NGINX_PORT}/{code}/sse")
            if active:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                        d = json.loads(resp.read())
                        print(f"  conns    : {d.get('active_connections', 0)} active")
                except Exception:
                    print(f"  health   : {YELLOW}unreachable{NC}")
    print()

def remove_entity(code):
    svc = f"suitecrm-mcp-{code}"
    run(["systemctl", "stop", svc], check=False)
    run(["systemctl", "disable", svc], check=False)
    for path in [f"/etc/systemd/system/{svc}.service", f"{ENV_DIR}/{code}.env"]:
        if Path(path).exists():
            os.remove(path)
            ok(f"  Removed: {path}")
    run(["systemctl", "daemon-reload"])
    ok(f"Entity '{code}' removed.")

def main():
    parser = argparse.ArgumentParser(description="SuiteCRM MCP Gateway - Multi-Entity Installer")
    parser.add_argument("--config",  default="entities.json", help="Path to entities config (default: entities.json)")
    parser.add_argument("--add",     action="store_true", help="Add only new entities from config (no reinstall of existing)")
    parser.add_argument("--remove",  nargs="+", metavar="CODE", help="Remove one or more entity codes")
    parser.add_argument("--status",  action="store_true", help="Show status of all running entities")
    parser.add_argument("--update",  action="store_true", help="Update server code and restart all services")
    parser.add_argument("--domain",  help="Domain for HTTPS via Let's Encrypt (e.g. mcp.example.com)")
    parser.add_argument("--email",   help="Email for Let's Encrypt cert (required with --domain)")
    args = parser.parse_args()

    if args.domain and not args.email:
        error("--email is required when --domain is set (needed for Let's Encrypt)")
    if args.domain: validate_domain(args.domain)
    if args.email:  validate_email(args.email)
    if args.remove:
        for c in args.remove: validate_code(c)

    if os.geteuid() != 0: error("Run as root (sudo)")

    if args.status:
        show_status(); sys.exit(0)

    if args.remove:
        warn(f"Removing entities: {', '.join(args.remove)}")
        if input("  Type 'yes' to confirm: ").strip().lower() != "yes":
            info("Aborted."); sys.exit(0)
        for code in args.remove: remove_entity(code)
        remaining = {c: d for c, d in load_entities(args.config).items() if c not in args.remove}
        if remaining:
            info("Rebuilding nginx for remaining entities...")
            rebuild_nginx(remaining)
        else:
            info("No entities remain - removing nginx config...")
            for path in [NGINX_LINK, NGINX_CONF]:
                if Path(path).exists():
                    os.remove(path)
                    ok(f"Removed: {path}")
            run(["systemctl", "reload", "nginx"], check=False)
        sys.exit(0)

    entities = load_entities(args.config)
    print(); info("=" * 60); info("SUITECRM MCP GATEWAY - MULTI-ENTITY INSTALLER"); info("=" * 60)
    info(f"Entities: {', '.join(entities.keys())}"); print()

    if args.update:
        info("Update mode - reinstalling server code...")
        install_server(); print()
        info("Restarting all services...")
        for code in entities:
            run(["systemctl", "restart", f"suitecrm-mcp-{code}"], check=False)
            ok(f"  Restarted: suitecrm-mcp-{code}")
        show_status(entities); sys.exit(0)

    running = set(get_running_entities())
    to_install = set(entities.keys())
    if args.add:
        new_entities = {c: d for c, d in entities.items() if c not in running}
        if not new_entities:
            info("No new entities to add - all are already installed."); sys.exit(0)
        info(f"Adding: {', '.join(new_entities.keys())}")
        to_install = set(new_entities.keys())

    check_deps(); print()
    info("Installing shared server..."); install_server(); print()

    os.makedirs(ENV_DIR, exist_ok=True)
    run(["chmod", "700", ENV_DIR])

    info("Installing env files and services...")
    for code in to_install:
        data = entities[code]
        label = data.get("label", code)
        install_env_for(code, data)
        install_service_for(code, label)
    run(["systemctl", "daemon-reload"])
    for code in to_install:
        run(["systemctl", "enable", "--now", f"suitecrm-mcp-{code}"])
        ok(f"  Started: suitecrm-mcp-{code}")
    print()

    info("Configuring nginx...")
    # Always rebuild nginx with ALL configured entities (not just new ones)
    rebuild_nginx(entities, domain=args.domain); print()

    if args.domain:
        os.makedirs(ENV_DIR, exist_ok=True)
        Path(DOMAIN_FILE).write_text(args.domain)
        info("Setting up HTTPS...")
        install_certbot()
        r = run(
            ["certbot", "--nginx", "-d", args.domain, "--non-interactive", "--agree-tos", "-m", args.email, "--redirect"],
            check=False, capture=True
        )
        if r.returncode != 0:
            warn(f"certbot failed:\n{r.stderr.strip()}")
            warn("Gateway is running but HTTPS setup failed. Check that:")
            warn(f"  - {args.domain} points to this server's public IP")
            warn("  - Port 80 is open (needed for the ACME challenge)")
            warn("  - Port 443 is open")
            warn(f"  Re-run manually: certbot --nginx -d {args.domain} -m {args.email} --agree-tos --redirect")
        else:
            ok(f"TLS certificate obtained for {args.domain}")
            ok("Auto-renewal configured via certbot systemd timer")
        print()

    show_status(entities)
    if args.domain:
        print(f"  Connect at: https://{args.domain}/<code>/sse")
    else:
        print(f"  Connect at: http://YOUR_SERVER_IP:{NGINX_PORT}/<code>/sse")
    print()
    info("Use X-CRM-User and X-CRM-Pass headers when connecting.")
    info("See README.md for Claude Desktop / Claude Code config examples.")
    print()

if __name__ == "__main__":
    main()
