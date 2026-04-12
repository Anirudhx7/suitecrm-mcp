#!/usr/bin/env python3
"""
SuiteCRM MCP Gateway - Single Entity Installer
===============================================
Installs one MCP gateway instance for one SuiteCRM.
No nginx required - connect directly to the port.

Usage:
  sudo python3 install-single.py                  # interactive prompts
  sudo python3 install-single.py --endpoint https://crm.example.com/service/v4_1/rest.php
  sudo python3 install-single.py --update         # update server code + restart
  sudo python3 install-single.py --status         # show status
  sudo python3 install-single.py --uninstall      # remove everything

Options:
  --endpoint   SuiteCRM REST endpoint URL (required)
  --port       Listen port (default: 3101)
  --prefix     Tool name prefix (default: suitecrm)
  --label      Service description (default: My CRM)
  --tls-skip   Disable TLS verification for self-signed certs (NOT recommended)
  --domain     Domain name to enable HTTPS via Let's Encrypt (e.g. mcp.example.com)
  --email      Email for Let's Encrypt certificate (required when --domain is set)

HTTPS notes (--domain):
  - The domain must already point to this server's public IP
  - Ports 80 and 443 must be open (80 for the ACME challenge, 443 for HTTPS)
  - Installs nginx as a TLS-terminating reverse proxy in front of the gateway
  - Obtains and auto-renews a certificate via certbot
  - Without --domain, the gateway is reachable over plain HTTP on --port (default 3101)
"""

import os, sys, subprocess, json, argparse, shutil, re
from pathlib import Path

SERVER_DIR  = "/opt/suitecrm-mcp"
ENV_FILE    = "/etc/suitecrm-mcp/gateway.env"
SVC_NAME    = "suitecrm-mcp"
SVC_FILE    = f"/etc/systemd/system/{SVC_NAME}.service"
NGINX_CONF  = "/etc/nginx/sites-available/suitecrm-mcp"
NGINX_LINK  = "/etc/nginx/sites-enabled/suitecrm-mcp"
SVC_USER    = "suitecrm-mcp"  # unprivileged system user the gateway runs as

RED = "\033[0;31m"; GREEN = "\033[0;32m"; YELLOW = "\033[1;33m"; CYAN = "\033[0;36m"; NC = "\033[0m"
def info(m): print(f"{CYAN}[INFO]{NC} {m}")
def ok(m):   print(f"{GREEN}[OK]{NC} {m}")
def warn(m): print(f"{YELLOW}[WARN]{NC} {m}")
def error(m): print(f"{RED}[ERROR]{NC} {m}"); sys.exit(1)

SAFE_DOMAIN_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9.-]+$')
SAFE_EMAIL_RE  = re.compile(r'^[^@\s,;|&<>]+@[^@\s,;|&<>]+\.[^@\s,;|&<>]+$')

def validate_domain(d):
    if not SAFE_DOMAIN_RE.match(d):
        error(f"Invalid domain: {d!r} - must contain only letters, digits, hyphens, and dots")

def validate_email(e):
    if not SAFE_EMAIL_RE.match(e):
        error(f"Invalid email address: {e!r}")

def ensure_service_user():
    r = run(["id", SVC_USER], check=False, capture=True)
    if r.returncode != 0:
        run(["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", SVC_USER])
        ok(f"Created system user: {SVC_USER}")
    else:
        ok(f"Service user exists: {SVC_USER}")

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

def check_node():
    if not shutil.which("node"):
        info("Installing Node.js LTS...")
        run("curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -")  # shell pipeline - no list form possible
        run(["apt-get", "install", "-y", "nodejs"])
        ok(f"Node.js installed: {run(['node', '--version'], capture=True).stdout.strip()}")
    else:
        ok(f"Node.js: {run(['node', '--version'], capture=True).stdout.strip()}")

def install_server():
    info(f"Installing server to {SERVER_DIR} ...")
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

def install_env(endpoint, port, prefix, label, tls_skip, behind_proxy=False):
    lines = [
        f"# SuiteCRM MCP Gateway - {label}",
        f"SUITECRM_ENDPOINT={endpoint}",
        f"SUITECRM_PREFIX={prefix}",
        f"PORT={port}",
        "NODE_NO_WARNINGS=1",
    ]
    if tls_skip:
        warn("TLS verification disabled. Only use this for self-signed certificates on trusted networks.")
        lines.append("NODE_TLS_REJECT_UNAUTHORIZED=0")
    if behind_proxy:
        lines.append("TRUST_PROXY=1")
    lines.append("")
    write_file(ENV_FILE, "\n".join(lines), mode="600")
    run(["chown", f"{SVC_USER}:{SVC_USER}", ENV_FILE])
    env_dir = str(Path(ENV_FILE).parent)
    run(["chmod", "700", env_dir])
    run(["chown", f"{SVC_USER}:{SVC_USER}", env_dir])
    ok(f"Env file: {ENV_FILE}")

def install_service(port, label):
    nb = node_bin()
    content = (
        f"[Unit]\n"
        f"Description=SuiteCRM MCP Gateway - {label}\n"
        f"After=network.target\n\n"
        f"[Service]\n"
        f"Type=simple\n"
        f"User={SVC_USER}\n"
        f"Group={SVC_USER}\n"
        f"EnvironmentFile={ENV_FILE}\n"
        f"ExecStart={nb} {SERVER_DIR}/index.mjs\n"
        f"Restart=always\n"
        f"RestartSec=5\n"
        f"StandardOutput=journal\n"
        f"StandardError=journal\n"
        f"SyslogIdentifier={SVC_NAME}\n\n"
        f"[Install]\n"
        f"WantedBy=multi-user.target\n"
    )
    write_file(SVC_FILE, content)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", SVC_NAME])
    ok(f"Service started: {SVC_NAME}")

def show_status():
    import urllib.request
    r = run(["systemctl", "is-active", SVC_NAME], check=False, capture=True)
    active = r.stdout.strip() == "active"
    status_str = f"{GREEN}active{NC}" if active else f"{RED}inactive{NC}"

    # Read port from env
    port = 3101
    if Path(ENV_FILE).exists():
        with open(ENV_FILE) as f:
            for line in f:
                if line.startswith("PORT="):
                    try: port = int(line.split("=")[1].strip())
                    except: pass

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
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                d = json.loads(resp.read())
                print(f"  conns   : {d.get('active_connections', 0)} active")
        except Exception:
            print(f"  health  : {YELLOW}unreachable{NC}")
    print()

def uninstall():
    warn("This will stop and remove the SuiteCRM MCP gateway.")
    if input("  Type 'yes' to confirm: ").strip().lower() != "yes":
        info("Aborted."); sys.exit(0)
    run(["systemctl", "stop", SVC_NAME], check=False)
    run(["systemctl", "disable", SVC_NAME], check=False)
    for path in [SVC_FILE, ENV_FILE, SERVER_DIR, NGINX_LINK, NGINX_CONF]:
        if Path(path).exists():
            if Path(path).is_dir(): shutil.rmtree(path)
            else: os.remove(path)
            ok(f"Removed: {path}")
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "reload", "nginx"], check=False)
    ok("Uninstalled.")

def install_nginx_tls(domain, email, port):
    """Install nginx as TLS terminator + obtain Let's Encrypt cert via certbot."""
    if not shutil.which("nginx"):
        info("Installing nginx...")
        run(["apt-get", "update", "-qq"])
        run(["apt-get", "install", "-y", "nginx"])
        ok("nginx installed")
    else:
        ok("nginx: present")

    if not shutil.which("certbot"):
        info("Installing certbot...")
        run(["apt-get", "install", "-y", "certbot", "python3-certbot-nginx"])
        ok("certbot installed")
    else:
        ok("certbot: present")

    # Write HTTP-only config first; certbot --nginx will add the SSL block
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
    if not Path(NGINX_LINK).exists():
        os.symlink(NGINX_CONF, NGINX_LINK)
    default_site = "/etc/nginx/sites-enabled/default"
    if Path(default_site).exists():
        os.remove(default_site)
        warn("Removed nginx default site")
    run(["nginx", "-t"])
    run(["systemctl", "enable", "--now", "nginx"])
    run(["systemctl", "reload", "nginx"])
    ok("nginx configured")

    info(f"Obtaining TLS certificate for {domain} ...")
    r = run(
        ["certbot", "--nginx", "-d", domain, "--non-interactive", "--agree-tos", "-m", email, "--redirect"],
        check=False, capture=True
    )
    if r.returncode != 0:
        warn(f"certbot failed:\n{r.stderr.strip()}")
        warn("Gateway is running but HTTPS setup failed. Check that:")
        warn(f"  - {domain} points to this server's public IP")
        warn("  - Port 80 is open (needed for the ACME challenge)")
        warn("  - Port 443 is open")
        warn(f"  Re-run manually: certbot --nginx -d {domain} -m {email} --agree-tos --redirect")
    else:
        ok(f"TLS certificate obtained for {domain}")
        ok("Auto-renewal configured via certbot systemd timer")


def prompt_if_missing(val, prompt_text, default=None):
    if val: return val
    suffix = f" [{default}]" if default else ""
    resp = input(f"  {prompt_text}{suffix}: ").strip()
    return resp or default

def main():
    parser = argparse.ArgumentParser(description="SuiteCRM MCP Gateway - Single Entity Installer")
    parser.add_argument("--endpoint", help="SuiteCRM REST endpoint URL")
    parser.add_argument("--port",     type=int, default=3101, help="Listen port (default: 3101)")
    parser.add_argument("--prefix",   default="suitecrm", help="Tool name prefix (default: suitecrm)")
    parser.add_argument("--label",    default="My CRM", help="Service description")
    parser.add_argument("--tls-skip", action="store_true", help="Disable TLS cert verification")
    parser.add_argument("--domain",   help="Domain for HTTPS via Let's Encrypt (e.g. mcp.example.com)")
    parser.add_argument("--email",    help="Email for Let's Encrypt cert (required with --domain)")
    parser.add_argument("--update",   action="store_true", help="Update server code and restart")
    parser.add_argument("--status",   action="store_true", help="Show status")
    parser.add_argument("--uninstall",action="store_true", help="Remove everything")
    args = parser.parse_args()

    if args.domain and not args.email:
        error("--email is required when --domain is set (needed for Let's Encrypt)")
    if args.domain: validate_domain(args.domain)
    if args.email:  validate_email(args.email)

    if os.geteuid() != 0: error("Run as root (sudo)")

    if args.status:
        show_status(); sys.exit(0)

    if args.uninstall:
        uninstall(); sys.exit(0)

    print(); info("=" * 56); info("SUITECRM MCP GATEWAY - SINGLE ENTITY INSTALLER"); info("=" * 56); print()

    if args.update:
        info("Update mode - reinstalling server code...")
        install_server()
        run(["systemctl", "restart", SVC_NAME])
        ok(f"Restarted: {SVC_NAME}")
        show_status(); sys.exit(0)

    # Interactive prompts for missing values
    endpoint = prompt_if_missing(args.endpoint,
        "SuiteCRM REST endpoint (e.g. https://crm.example.com/service/v4_1/rest.php)")
    if not endpoint:
        error("--endpoint is required")

    info("Checking Node.js..."); check_node(); print()
    info("Ensuring service user..."); ensure_service_user(); print()
    info("Installing server..."); install_server(); print()
    info("Writing env file..."); install_env(endpoint, args.port, args.prefix, args.label, args.tls_skip, behind_proxy=bool(args.domain)); print()
    info("Installing systemd service..."); install_service(args.port, args.label); print()

    if args.domain:
        info("Setting up HTTPS..."); install_nginx_tls(args.domain, args.email, args.port); print()

    show_status()
    if args.domain:
        print(f"  SSE endpoint : https://{args.domain}/sse")
    else:
        print(f"  SSE endpoint : http://YOUR_SERVER_IP:{args.port}/sse")
    print()
    info("Connect with X-CRM-User and X-CRM-Pass headers.")
    info("See README.md for Claude Desktop / Claude Code config examples.")
    print()

if __name__ == "__main__":
    main()
