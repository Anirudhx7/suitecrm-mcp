#!/usr/bin/env python3
"""
SuiteCRM MCP Gateway — Single Entity Installer
===============================================
Installs one MCP gateway instance for one SuiteCRM.
No nginx required — connect directly to the port.

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
"""

import os, sys, subprocess, json, argparse, shutil
from pathlib import Path

SERVER_DIR = "/opt/suitecrm-mcp"
ENV_FILE   = "/etc/suitecrm-mcp/gateway.env"
SVC_NAME   = "suitecrm-mcp"
SVC_FILE   = f"/etc/systemd/system/{SVC_NAME}.service"

RED = "\033[0;31m"; GREEN = "\033[0;32m"; YELLOW = "\033[1;33m"; CYAN = "\033[0;36m"; NC = "\033[0m"
def info(m): print(f"{CYAN}[INFO]{NC} {m}")
def ok(m):   print(f"{GREEN}[OK]{NC} {m}")
def warn(m): print(f"{YELLOW}[WARN]{NC} {m}")
def error(m): print(f"{RED}[ERROR]{NC} {m}"); sys.exit(1)

def run(cmd, check=True, capture=False):
    if isinstance(cmd, str): cmd = ["bash", "-c", cmd]
    r = subprocess.run(cmd, capture_output=capture, text=True)
    if check and r.returncode != 0:
        error(f"Command failed: {' '.join(cmd)}\n{r.stderr.strip() if capture else ''}")
    return r

def write_file(path, content, mode=None):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f: f.write(content)
    if mode: run(["chmod", mode, path])

def node_bin():
    r = run("which node", check=False, capture=True)
    return r.stdout.strip() if r.returncode == 0 else "/usr/bin/node"

def script_dir():
    return Path(__file__).parent.resolve()

def check_node():
    if run("which node", check=False, capture=True).returncode != 0:
        info("Installing Node.js LTS...")
        run("curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -")
        run("apt-get install -y nodejs")
        ok(f"Node.js installed: {run('node --version', capture=True).stdout.strip()}")
    else:
        ok(f"Node.js: {run('node --version', capture=True).stdout.strip()}")

def install_server():
    info(f"Installing server to {SERVER_DIR} ...")
    os.makedirs(SERVER_DIR, exist_ok=True)
    src = script_dir() / "server" / "index.mjs"
    pkg = script_dir() / "server" / "package.json"
    if not src.exists():
        error(f"server/index.mjs not found. Run from the repo root directory.")
    shutil.copy(src, f"{SERVER_DIR}/index.mjs")
    shutil.copy(pkg, f"{SERVER_DIR}/package.json")
    run(f"cd {SERVER_DIR} && npm install --silent")
    ok("Server installed")

def install_env(endpoint, port, prefix, label, tls_skip):
    lines = [
        f"# SuiteCRM MCP Gateway — {label}",
        f"SUITECRM_ENDPOINT={endpoint}",
        f"SUITECRM_PREFIX={prefix}",
        f"PORT={port}",
        "NODE_NO_WARNINGS=1",
    ]
    if tls_skip:
        warn("TLS verification disabled. Only use this for self-signed certificates on trusted networks.")
        lines.append("NODE_TLS_REJECT_UNAUTHORIZED=0")
    lines.append("")
    write_file(ENV_FILE, "\n".join(lines), mode="600")
    run(["chmod", "700", str(Path(ENV_FILE).parent)])
    ok(f"Env file: {ENV_FILE}")

def install_service(port, label):
    nb = node_bin()
    content = (
        f"[Unit]\n"
        f"Description=SuiteCRM MCP Gateway — {label}\n"
        f"After=network.target\n\n"
        f"[Service]\n"
        f"Type=simple\n"
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
    run("systemctl daemon-reload")
    run(f"systemctl enable --now {SVC_NAME}")
    ok(f"Service started: {SVC_NAME}")

def show_status():
    import urllib.request
    r = run(f"systemctl is-active {SVC_NAME}", check=False, capture=True)
    active = r.stdout.strip() == "active"
    status_str = f"{GREEN}active{NC}" if active else f"{RED}inactive{NC}"

    # Read port from env
    port = 3101
    if Path(ENV_FILE).exists():
        for line in open(ENV_FILE):
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
    run(f"systemctl stop {SVC_NAME}", check=False)
    run(f"systemctl disable {SVC_NAME}", check=False)
    for path in [SVC_FILE, ENV_FILE, SERVER_DIR]:
        if Path(path).exists():
            if Path(path).is_dir(): shutil.rmtree(path)
            else: os.remove(path)
            ok(f"Removed: {path}")
    run("systemctl daemon-reload")
    ok("Uninstalled.")

def prompt_if_missing(val, prompt_text, default=None):
    if val: return val
    suffix = f" [{default}]" if default else ""
    resp = input(f"  {prompt_text}{suffix}: ").strip()
    return resp or default

def main():
    parser = argparse.ArgumentParser(description="SuiteCRM MCP Gateway — Single Entity Installer")
    parser.add_argument("--endpoint", help="SuiteCRM REST endpoint URL")
    parser.add_argument("--port",     type=int, default=3101, help="Listen port (default: 3101)")
    parser.add_argument("--prefix",   default="suitecrm", help="Tool name prefix (default: suitecrm)")
    parser.add_argument("--label",    default="My CRM", help="Service description")
    parser.add_argument("--tls-skip", action="store_true", help="Disable TLS cert verification")
    parser.add_argument("--update",   action="store_true", help="Update server code and restart")
    parser.add_argument("--status",   action="store_true", help="Show status")
    parser.add_argument("--uninstall",action="store_true", help="Remove everything")
    args = parser.parse_args()

    if os.geteuid() != 0: error("Run as root (sudo)")

    if args.status:
        show_status(); sys.exit(0)

    if args.uninstall:
        uninstall(); sys.exit(0)

    print(); info("=" * 56); info("SUITECRM MCP GATEWAY — SINGLE ENTITY INSTALLER"); info("=" * 56); print()

    if args.update:
        info("Update mode — reinstalling server code...")
        install_server()
        run(f"systemctl restart {SVC_NAME}")
        ok(f"Restarted: {SVC_NAME}")
        show_status(); sys.exit(0)

    # Interactive prompts for missing values
    endpoint = prompt_if_missing(args.endpoint,
        "SuiteCRM REST endpoint (e.g. https://crm.example.com/service/v4_1/rest.php)")
    if not endpoint:
        error("--endpoint is required")

    info("Checking Node.js..."); check_node(); print()
    info("Installing server..."); install_server(); print()
    info("Writing env file..."); install_env(endpoint, args.port, args.prefix, args.label, args.tls_skip); print()
    info("Installing systemd service..."); install_service(args.port, args.label); print()

    show_status()
    print(f"  SSE endpoint : http://YOUR_SERVER_IP:{args.port}/sse")
    print()
    info("Connect with X-CRM-User and X-CRM-Pass headers.")
    info("See README.md for Claude Desktop / Claude Code config examples.")
    print()

if __name__ == "__main__":
    main()
