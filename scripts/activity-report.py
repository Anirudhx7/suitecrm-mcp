#!/usr/bin/env python3
"""
SuiteCRM MCP Gateway — Activity Report Generator
Reads from the persistent audit log (SQLite: /var/log/suitecrm-mcp/audit.db),
falls back to Loki for data before the DB existed.
SMTP config is read from Alertmanager's config so you configure credentials once.

Usage:
  python3 activity-report.py --period daily
  python3 activity-report.py --period weekly
  python3 activity-report.py --period monthly
  python3 activity-report.py --period daily --date 2026-06-17   # specific date
  python3 activity-report.py --period daily --stdout            # print HTML, no email
"""

import argparse
import json
import os
import re
import smtplib
import sqlite3
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

ALERTMANAGER_YML = '/opt/suitecrm-mcp-monitoring/alertmanager.yml'
LOKI_URL         = 'http://localhost:3200'
MAX_LOG_LINES    = 5000
AUDIT_DB         = '/var/log/suitecrm-mcp/audit.db'

# ---------------------------------------------------------------------------
# SMTP config — read from alertmanager.yml so you configure SMTP in one place
# ---------------------------------------------------------------------------
def load_smtp_from_alertmanager(path=ALERTMANAGER_YML):
    """Parse SMTP settings out of alertmanager.yml global section and email_configs."""
    cfg = {}
    try:
        with open(path) as f:
            text = f.read()
    except FileNotFoundError:
        return cfg

    def get(pattern, default=''):
        m = re.search(pattern, text, re.MULTILINE)
        return m.group(1).strip().strip("'\"") if m else default

    cfg['host']     = get(r'^\s*smtp_smarthost:\s*[\'"]?([^\s\'"#]+)', '')
    cfg['from']     = get(r'^\s*smtp_from:\s*[\'"]?([^\s\'"#]+)', '')
    cfg['user']     = get(r'^\s*smtp_auth_username:\s*[\'"]?([^\s\'"#]+)', '')
    cfg['password'] = get(r'^\s*smtp_auth_password:\s*[\'"]?([^\s\'"#]+)', '')
    tls_raw         = get(r'^\s*smtp_require_tls:\s*([^\s#]+)', 'true')
    cfg['tls']      = tls_raw.lower() not in ('false', '0', 'no')

    # First `to:` inside email_configs section
    m = re.search(r'email_configs:.*?to:\s*[\'"]?([^\s\'"#\n]+)', text, re.DOTALL)
    cfg['to'] = m.group(1).strip().strip("'\"") if m else ''

    return cfg

def load_smtp_overrides(cfg):
    """Allow env-var overrides for any setting."""
    if os.environ.get('SMTP_HOST'):     cfg['host']     = os.environ['SMTP_HOST']
    if os.environ.get('SMTP_USER'):     cfg['user']     = os.environ['SMTP_USER']
    if os.environ.get('SMTP_PASS'):     cfg['password'] = os.environ['SMTP_PASS']
    if os.environ.get('SMTP_FROM'):     cfg['from']     = os.environ['SMTP_FROM']
    if os.environ.get('REPORT_TO'):     cfg['to']       = os.environ['REPORT_TO']
    if os.environ.get('LOKI_URL'):      pass  # handled separately
    return cfg

# ---------------------------------------------------------------------------
# Time range helpers
# ---------------------------------------------------------------------------
def get_time_range(period: str, ref: datetime):
    end   = ref.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == 'daily':
        start = end - timedelta(days=1)
        label = f"Daily Report — {start.strftime('%A, %d %B %Y')}"
    elif period == 'weekly':
        start = end - timedelta(days=7)
        label = f"Weekly Report — {start.strftime('%d %b')} to {(end - timedelta(days=1)).strftime('%d %b %Y')}"
    elif period == 'monthly':
        start = end - timedelta(days=30)
        label = f"Monthly Report — {start.strftime('%d %b')} to {(end - timedelta(days=1)).strftime('%d %b %Y')}"
    else:
        raise ValueError(f"Unknown period: {period}")
    return start, end, label

# ---------------------------------------------------------------------------
# Audit DB reader (primary source — persistent, email-indexed SQLite)
# ---------------------------------------------------------------------------
def read_audit_db(start: datetime, end: datetime):
    """Read audit records from SQLite for the given time range."""
    if not os.path.exists(AUDIT_DB):
        return []
    records = []
    try:
        con = sqlite3.connect(f'file:{AUDIT_DB}?mode=ro', uri=True)
        con.row_factory = sqlite3.Row
        cur = con.execute(
            "SELECT ts, email, entity, tool, msg, err FROM audit_log "
            "WHERE ts >= ? AND ts < ? AND msg IN ('tool_done', 'tool_error') "
            "ORDER BY ts",
            (start.isoformat(), end.isoformat()),
        )
        for row in cur:
            try:
                ts = datetime.fromisoformat(row['ts'].replace('Z', '+00:00'))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                ts_ns = int(ts.timestamp() * 1e9)
            except (ValueError, AttributeError):
                continue
            entry = {
                'msg':    row['msg'],
                'email':  row['email']  or 'unknown',
                'tool':   row['tool']   or '',
                'entity': row['entity'] or '',
                'err':    row['err']    or '',
                'ts':     row['ts'],
            }
            records.append((ts_ns, json.dumps(entry)))
        con.close()
    except Exception as e:
        print(f'[WARN] Could not read audit DB {AUDIT_DB}: {e}', file=sys.stderr)
    return records

# ---------------------------------------------------------------------------
# Loki query (fallback — used only if audit file has no data for the period)
# ---------------------------------------------------------------------------
def loki_query(loki_base: str, logql: str, start: datetime, end: datetime, limit: int = MAX_LOG_LINES):
    params = {
        'query':     logql,
        'start':     str(int(start.timestamp() * 1e9)),
        'end':       str(int(end.timestamp() * 1e9)),
        'limit':     str(limit),
        'direction': 'forward',
    }
    url = f"{loki_base}/loki/api/v1/query_range?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.load(resp)
    except Exception as e:
        print(f"[WARN] Loki query failed: {e}", file=sys.stderr)
        return []
    results = []
    for stream in data.get('data', {}).get('result', []):
        for ts_ns, line in stream.get('values', []):
            results.append((int(ts_ns), line))
    results.sort(key=lambda x: x[0])
    return results

# ---------------------------------------------------------------------------
# Parse and aggregate audit logs
# ---------------------------------------------------------------------------
WRITE_KEYWORDS = {'create', 'update', 'log_call', 'upsert', 'create_task', 'create_note', 'set_note_attachment', 'link_records', 'unlink_records'}

def aggregate(log_entries):
    user_calls    = defaultdict(int)
    user_errors   = defaultdict(int)
    user_tools    = defaultdict(lambda: defaultdict(int))
    user_writes   = defaultdict(int)
    user_entities = defaultdict(set)
    tool_totals   = defaultdict(int)
    entity_totals = defaultdict(int)
    raw_errors    = []
    total_calls   = 0
    total_errors  = 0
    total_writes  = 0

    for ts_ns, line in log_entries:
        try:
            entry = json.loads(line)
        except Exception:
            continue

        # Audit file format: has 'email', 'tool' (short), 'entity' (short), no 'audit' flag
        # Loki/journal format: has 'audit':true, 'email' from child logger, 'entity' with suitecrm_ prefix
        is_file_format = 'email' in entry and entry.get('msg') in ('tool_call', 'tool_done', 'tool_error')
        if not is_file_format and not entry.get('audit'):
            continue

        msg    = entry.get('msg', '')
        tool   = entry.get('tool', '')
        email  = entry.get('email', 'unknown')
        entity = entry.get('entity', '')
        if entity.startswith('suitecrm_'):
            entity = entity[len('suitecrm_'):]
        # For Loki format, strip entity prefix from tool name too (suitecrm_aeau_search → search)
        if '_' in tool and not is_file_format:
            parts = tool.split('_')
            # tool format: suitecrm_aeau_search → last part(s) after entity code
            tool = '_'.join(parts[2:]) if len(parts) > 2 else tool

        if msg == 'tool_done':
            total_calls += 1
            user_calls[email] += 1
            user_tools[email][tool] += 1
            user_entities[email].add(entity)
            tool_totals[tool] += 1
            entity_totals[entity] += 1
            if tool in WRITE_KEYWORDS or any(w in tool for w in WRITE_KEYWORDS):
                user_writes[email] += 1
                total_writes += 1

        elif msg == 'tool_error':
            total_errors += 1
            user_errors[email] += 1
            ts_dt = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)
            raw_errors.append({
                'ts':     ts_dt.strftime('%Y-%m-%d %H:%M:%S UTC'),
                'email':  email,
                'tool':   tool,
                'err':    entry.get('err', ''),
                'entity': entity,
            })

    return {
        'user_calls':    dict(user_calls),
        'user_errors':   dict(user_errors),
        'user_tools':    {k: dict(v) for k, v in user_tools.items()},
        'user_writes':   dict(user_writes),
        'user_entities': {k: sorted(v) for k, v in user_entities.items()},
        'tool_totals':   dict(tool_totals),
        'entity_totals': dict(entity_totals),
        'total_calls':   total_calls,
        'total_errors':  total_errors,
        'total_writes':  total_writes,
        'raw_errors':    raw_errors[-50:],
    }

# ---------------------------------------------------------------------------
# HTML report builder
# ---------------------------------------------------------------------------
def build_html(stats: dict, period_label: str, start: datetime, end: datetime) -> str:
    users_by_calls = sorted(stats['user_calls'].items(), key=lambda x: x[1], reverse=True)
    top_tools      = sorted(stats['tool_totals'].items(), key=lambda x: x[1], reverse=True)[:15]
    top_entities   = sorted(stats['entity_totals'].items(), key=lambda x: x[1], reverse=True)

    total  = stats['total_calls']
    errors = stats['total_errors']
    writes = stats['total_writes']
    err_pct = f"{errors/total*100:.1f}%" if total > 0 else "0%"

    def row_bg(err_count):
        if err_count == 0:  return ''
        if err_count < 3:   return 'background:#fff3cd'
        return 'background:#f8d7da'

    user_rows = ''
    for email, calls in users_by_calls:
        errs      = stats['user_errors'].get(email, 0)
        writes_n  = stats['user_writes'].get(email, 0)
        entities  = ', '.join(stats['user_entities'].get(email, []))
        top3      = sorted(stats['user_tools'].get(email, {}).items(), key=lambda x: x[1], reverse=True)[:3]
        top3_str  = ', '.join(f"{t} ({n})" for t, n in top3)
        ep        = f"{errs/calls*100:.0f}%" if calls > 0 else "0%"
        user_rows += f"""
        <tr style="{row_bg(errs)}">
          <td style="padding:6px 10px;border-bottom:1px solid #dee2e6">{email}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;text-align:center">{calls}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;text-align:center">{'<span style="color:#dc3545;font-weight:bold">' + str(errs) + ' (' + ep + ')' + '</span>' if errs else '0'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;text-align:center">{writes_n}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #dee2e6;font-size:13px">{top3_str}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #dee2e6">{entities}</td>
        </tr>"""

    tool_rows = ''
    for tool, count in top_tools:
        pct = f"{count/total*100:.1f}%" if total > 0 else "0%"
        tool_rows += f"""
        <tr>
          <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;font-family:monospace;font-size:13px">{tool}</td>
          <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center">{count}</td>
          <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center;color:#888">{pct}</td>
        </tr>"""

    entity_rows = ''
    for ent, count in top_entities:
        pct = f"{count/total*100:.1f}%" if total > 0 else "0%"
        entity_rows += f"""
        <tr>
          <td style="padding:5px 10px;border-bottom:1px solid #dee2e6">{ent}</td>
          <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center">{count}</td>
          <td style="padding:5px 10px;border-bottom:1px solid #dee2e6;text-align:center;color:#888">{pct}</td>
        </tr>"""

    error_section = ''
    if stats['raw_errors']:
        error_rows = ''
        for e in stats['raw_errors']:
            error_rows += f"""
            <tr>
              <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:11px;white-space:nowrap">{e['ts']}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:12px">{e['email']}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-family:monospace;font-size:12px">{e['tool']}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:12px">{e['entity']}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #f5c6cb;font-size:12px;color:#721c24">{e['err'][:250]}</td>
            </tr>"""
        error_section = f"""
    <h2 style="color:#721c24;margin-top:32px;font-size:16px">Errors ({len(stats['raw_errors'])} shown, {errors} total)</h2>
    <table style="width:100%;border-collapse:collapse;background:#fff5f5;font-size:13px">
      <thead>
        <tr style="background:#f8d7da">
          <th style="padding:6px 8px;text-align:left">Time</th>
          <th style="padding:6px 8px;text-align:left">User</th>
          <th style="padding:6px 8px;text-align:left">Tool</th>
          <th style="padding:6px 8px;text-align:left">Entity</th>
          <th style="padding:6px 8px;text-align:left">Error</th>
        </tr>
      </thead>
      <tbody>{error_rows}</tbody>
    </table>"""

    no_activity = '<p style="color:#888;font-style:italic;padding:12px 0">No user activity recorded in this period.</p>'
    generated_at = datetime.now(tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>MCP Gateway — {period_label}</title></head>
<body style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto;padding:20px;color:#333;font-size:14px">

  <div style="background:#1a73e8;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px">SuiteCRM MCP Gateway — Activity Report</h1>
    <p style="margin:4px 0 0;opacity:0.9;font-size:14px">{period_label}</p>
    <p style="margin:4px 0 0;opacity:0.75;font-size:12px">{start.strftime('%Y-%m-%d %H:%M UTC')} → {end.strftime('%Y-%m-%d %H:%M UTC')}</p>
  </div>

  <div style="background:#f8f9fa;padding:16px 24px;border:1px solid #dee2e6;border-top:none;display:flex;gap:0;flex-wrap:wrap">
    {''.join(f'''<div style="text-align:center;flex:1;min-width:110px;padding:8px;border-right:1px solid #dee2e6">
      <div style="font-size:28px;font-weight:bold;color:{c}">{v}</div>
      <div style="font-size:12px;color:#666;margin-top:2px">{lbl}</div>
    </div>''' for v,c,lbl in [
        (total,'#1a73e8','Total Calls'),
        (errors, '#dc3545' if errors else '#28a745', f'Errors ({err_pct})'),
        (writes,'#6f42c1','Write Ops'),
        (len(users_by_calls),'#fd7e14','Active Users'),
    ])}
  </div>

  <h2 style="margin-top:28px;font-size:16px">User Activity</h2>
  {no_activity if not user_rows else f'''
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="background:#e9ecef">
        <th style="padding:8px 10px;text-align:left">User</th>
        <th style="padding:8px 10px">Calls</th>
        <th style="padding:8px 10px">Errors</th>
        <th style="padding:8px 10px">Writes</th>
        <th style="padding:8px 10px;text-align:left">Top Tools Used</th>
        <th style="padding:8px 10px;text-align:left">Entities</th>
      </tr>
    </thead>
    <tbody>{user_rows}</tbody>
  </table>
  <p style="font-size:11px;color:#999;margin-top:4px">Rows in orange/red have elevated error counts.</p>'''}

  <div style="display:flex;gap:28px;margin-top:28px;flex-wrap:wrap">
    <div style="flex:1;min-width:260px">
      <h2 style="font-size:16px">Top Tools (by call count)</h2>
      {no_activity if not tool_rows else f'''
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e9ecef">
          <th style="padding:6px 10px;text-align:left">Tool</th>
          <th style="padding:6px 10px">Calls</th>
          <th style="padding:6px 10px">%</th>
        </tr></thead>
        <tbody>{tool_rows}</tbody>
      </table>'''}
    </div>
    <div style="flex:0 0 220px">
      <h2 style="font-size:16px">Calls by Entity</h2>
      {no_activity if not entity_rows else f'''
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e9ecef">
          <th style="padding:6px 10px;text-align:left">Entity</th>
          <th style="padding:6px 10px">Calls</th>
          <th style="padding:6px 10px">%</th>
        </tr></thead>
        <tbody>{entity_rows}</tbody>
      </table>'''}
    </div>
  </div>

  {error_section}

  <hr style="margin-top:40px;border:none;border-top:1px solid #dee2e6">
  <p style="font-size:11px;color:#bbb">Generated {generated_at} · SuiteCRM MCP Gateway</p>
</body>
</html>"""

# ---------------------------------------------------------------------------
# Email sender
# ---------------------------------------------------------------------------
def send_email(smtp_cfg: dict, subject: str, html_body: str):
    host_port = smtp_cfg.get('host', '')
    if ':' in host_port:
        host, port = host_port.rsplit(':', 1)
        port = int(port)
    else:
        host, port = host_port, 587

    user     = smtp_cfg.get('user', '')
    password = smtp_cfg.get('password', '')
    from_addr = smtp_cfg.get('from', user)
    to_addr   = smtp_cfg.get('to', '')
    use_tls   = smtp_cfg.get('tls', True)

    if not to_addr:
        print("[ERROR] No recipient configured. Set `to:` in alertmanager.yml email_configs or REPORT_TO env var.", file=sys.stderr)
        sys.exit(1)
    if not host:
        print("[ERROR] No SMTP host configured. Edit alertmanager.yml global section (smtp_smarthost).", file=sys.stderr)
        sys.exit(1)

    recipients = [r.strip() for r in to_addr.split(',') if r.strip()]

    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From']    = from_addr
    msg['To']      = ', '.join(recipients)

    msg.attach(MIMEText(f"MCP Gateway Report: {subject}\n\nOpen in an HTML email client.", 'plain'))
    msg.attach(MIMEText(html_body, 'html'))

    try:
        if use_tls:
            # STARTTLS: plain connect then upgrade (ports 25, 587)
            server = smtplib.SMTP(host, port, timeout=30)
            server.starttls()
        elif port == 465:
            # Implicit SSL (rare, legacy)
            server = smtplib.SMTP_SSL(host, port, timeout=30)
        else:
            # Plain SMTP — internal relays, port 25, no TLS
            server = smtplib.SMTP(host, port, timeout=30)
        if user:
            server.login(user, password)
        server.sendmail(from_addr, recipients, msg.as_string())
        server.quit()
        print(f"[OK] Report sent to: {', '.join(recipients)}")
    except Exception as e:
        print(f"[ERROR] Email failed: {e}", file=sys.stderr)
        sys.exit(1)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description='SuiteCRM MCP Gateway Activity Report')
    parser.add_argument('--period', choices=['daily', 'weekly', 'monthly'], default='daily')
    parser.add_argument('--date',   help='Reference date YYYY-MM-DD (default: today UTC)')
    parser.add_argument('--stdout', action='store_true', help='Print HTML to stdout, skip email')
    parser.add_argument('--loki',   default=None, help='Override Loki base URL')
    args = parser.parse_args()

    smtp_cfg = load_smtp_from_alertmanager()
    load_smtp_overrides(smtp_cfg)

    loki_base = args.loki or os.environ.get('LOKI_URL', LOKI_URL)

    if args.date:
        ref = datetime.strptime(args.date, '%Y-%m-%d').replace(tzinfo=timezone.utc) + timedelta(days=1)
    else:
        ref = datetime.now(tz=timezone.utc)

    start, end, period_label = get_time_range(args.period, ref)

    print(f"[INFO] Period: {start.isoformat()} → {end.isoformat()}", file=sys.stderr)

    # Prefer persistent audit DB; fall back to Loki for historical data before the DB existed
    entries = read_audit_db(start, end)
    if entries:
        print(f"[INFO] {len(entries)} entries from audit DB", file=sys.stderr)
    else:
        print(f"[INFO] Audit DB empty for this period — querying Loki", file=sys.stderr)
        entries = loki_query(loki_base, '{job="suitecrm-mcp", audit="true"} | json', start, end)
        print(f"[INFO] {len(entries)} entries from Loki", file=sys.stderr)

    stats = aggregate(entries)
    html  = build_html(stats, period_label, start, end)

    if args.stdout:
        print(html)
        return

    titles = {'daily': 'Daily', 'weekly': 'Weekly', 'monthly': 'Monthly'}
    if args.period == 'daily':
        subject = f"[MCP Gateway] Daily Activity — {start.strftime('%Y-%m-%d')}"
    elif args.period == 'weekly':
        subject = f"[MCP Gateway] Weekly Activity — w/e {(end - timedelta(days=1)).strftime('%Y-%m-%d')}"
    else:
        subject = f"[MCP Gateway] Monthly Activity — {start.strftime('%b %Y')}"

    send_email(smtp_cfg, subject, html)

if __name__ == '__main__':
    main()
