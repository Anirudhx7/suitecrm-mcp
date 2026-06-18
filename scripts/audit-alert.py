#!/usr/bin/env python3
"""
SuiteCRM MCP Gateway — Notorious User Alert Script
Runs every 15 minutes via cron. Queries the SQLite audit DB for the past hour,
identifies users exceeding abuse thresholds, and fires alerts to Alertmanager.
Alertmanager handles dedup, grouping, silencing, and email delivery.

Thresholds are tunable at the top of this file.
"""

import json
import os
import sqlite3
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

# ── Tunable thresholds ────────────────────────────────────────────────────────
CALL_RATE_WARNING  = 200   # calls per hour → warning
CALL_RATE_CRITICAL = 500   # calls per hour → critical
ERROR_RATE_MIN_CALLS = 10  # ignore error rate if user has fewer calls than this
ERROR_RATE_WARNING = 0.25  # 25% errors → warning
WRITE_RATE_WARNING = 100   # write tool_done per hour → warning
AUTH_FAIL_WARNING  = 5     # auth_failed events per hour → warning
RESULT_COUNT_WARNING = 1000  # single search returning >1000 records → warning

WRITE_TOOLS = {
    'create', 'update', 'log_call', 'upsert',
    'create_task', 'create_note', 'set_note_attachment',
    'link_records', 'unlink_records',
}

# ── Config ────────────────────────────────────────────────────────────────────
AUDIT_DB       = '/var/log/suitecrm-mcp/audit.db'
ALERTMANAGER   = 'http://localhost:9093'
WINDOW_MINUTES = 60   # look-back window for rate calculations
# Alerts auto-expire after this many seconds if not re-fired (must be > cron interval)
ALERT_TTL_SEC  = 1200  # 20 minutes — safe for 15-min cron


def now_utc():
    return datetime.now(tz=timezone.utc)


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def query_db(since_iso, until_iso):
    """Return all tool_done, tool_error, auth_failed rows in the window."""
    if not os.path.exists(AUDIT_DB):
        return []
    con = sqlite3.connect(f'file:{AUDIT_DB}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    cur = con.execute(
        "SELECT email, entity, tool, msg, status, result_count "
        "FROM audit_log "
        "WHERE ts >= ? AND ts < ? AND msg IN ('tool_done','tool_error','auth_failed')",
        (since_iso, until_iso),
    )
    rows = [dict(r) for r in cur]
    con.close()
    return rows


def analyse(rows):
    """Aggregate per-user stats. Returns list of (email, stat_dict)."""
    from collections import defaultdict
    stats = defaultdict(lambda: {
        'calls': 0, 'errors': 0, 'writes': 0, 'auth_fails': 0,
        'max_result': 0, 'entities': set(),
    })
    for r in rows:
        email = r['email'] or 'unknown'
        msg   = r['msg']
        tool  = r['tool'] or ''
        if msg == 'tool_done':
            stats[email]['calls'] += 1
            stats[email]['entities'].add(r['entity'])
            if tool in WRITE_TOOLS or any(w in tool for w in WRITE_TOOLS):
                stats[email]['writes'] += 1
            rc = r['result_count']
            if rc and rc > stats[email]['max_result']:
                stats[email]['max_result'] = rc
        elif msg == 'tool_error':
            stats[email]['calls'] += 1
            stats[email]['errors'] += 1
            stats[email]['entities'].add(r['entity'])
        elif msg == 'auth_failed':
            stats[email]['auth_fails'] += 1
    return [(e, s) for e, s in stats.items() if e != 'unknown']


def build_alerts(user_stats, window_start, window_end):
    """Return list of Alertmanager alert dicts to fire."""
    alerts = []
    starts_at = iso(window_start)
    ends_at   = iso(window_end + timedelta(seconds=ALERT_TTL_SEC))

    for email, s in user_stats:
        calls      = s['calls']
        errors     = s['errors']
        writes     = s['writes']
        auth_fails = s['auth_fails']
        max_result = s['max_result']
        entities   = ', '.join(sorted(s['entities'])) or 'unknown'
        err_rate   = errors / calls if calls > 0 else 0

        since_str = window_start.strftime('%Y-%m-%d')
        investigate = f"mcp-admin audit --email '{email}' --from {since_str}"

        # ── Call rate ────────────────────────────────────────────────────────
        if calls >= CALL_RATE_CRITICAL:
            alerts.append({
                'labels': {
                    'alertname': 'MCPUserHighCallRate',
                    'severity':  'critical',
                    'user':      email,
                    'entity':    entities,
                },
                'annotations': {
                    'summary':     f'Critical call rate: {email}',
                    'description': (
                        f'{email} made {calls} calls in the last hour (critical threshold: {CALL_RATE_CRITICAL}). '
                        f'Entities: {entities}. '
                        f'To investigate, run on the MCP server: {investigate}'
                    ),
                },
                'startsAt': starts_at,
                'endsAt':   ends_at,
            })
        elif calls >= CALL_RATE_WARNING:
            alerts.append({
                'labels': {
                    'alertname': 'MCPUserHighCallRate',
                    'severity':  'warning',
                    'user':      email,
                    'entity':    entities,
                },
                'annotations': {
                    'summary':     f'High call rate: {email}',
                    'description': (
                        f'{email} made {calls} calls in the last hour (warning threshold: {CALL_RATE_WARNING}). '
                        f'Entities: {entities}. '
                        f'To investigate, run on the MCP server: {investigate}'
                    ),
                },
                'startsAt': starts_at,
                'endsAt':   ends_at,
            })

        # ── Error rate ───────────────────────────────────────────────────────
        if calls >= ERROR_RATE_MIN_CALLS and err_rate >= ERROR_RATE_WARNING:
            alerts.append({
                'labels': {
                    'alertname': 'MCPUserHighErrorRate',
                    'severity':  'warning',
                    'user':      email,
                    'entity':    entities,
                },
                'annotations': {
                    'summary':     f'High error rate: {email}',
                    'description': (
                        f'{email} has a {err_rate*100:.0f}% error rate ({errors}/{calls} calls) in the last hour. '
                        f'Entities: {entities}. '
                        f'To investigate, run on the MCP server: {investigate}'
                    ),
                },
                'startsAt': starts_at,
                'endsAt':   ends_at,
            })

        # ── Write storm ──────────────────────────────────────────────────────
        if writes >= WRITE_RATE_WARNING:
            alerts.append({
                'labels': {
                    'alertname': 'MCPUserHighWriteRate',
                    'severity':  'warning',
                    'user':      email,
                    'entity':    entities,
                },
                'annotations': {
                    'summary':     f'High write volume: {email}',
                    'description': (
                        f'{email} performed {writes} write operations in the last hour (threshold: {WRITE_RATE_WARNING}). '
                        f'Entities: {entities}. '
                        f'To investigate, run on the MCP server: {investigate}'
                    ),
                },
                'startsAt': starts_at,
                'endsAt':   ends_at,
            })

        # ── Auth failures ────────────────────────────────────────────────────
        if auth_fails >= AUTH_FAIL_WARNING:
            alerts.append({
                'labels': {
                    'alertname': 'MCPUserAuthFailures',
                    'severity':  'warning',
                    'user':      email,
                    'entity':    entities,
                },
                'annotations': {
                    'summary':     f'Repeated auth failures: {email}',
                    'description': (
                        f'{email} had {auth_fails} authentication failures in the last hour. '
                        f'To investigate, run on the MCP server: {investigate}'
                    ),
                },
                'startsAt': starts_at,
                'endsAt':   ends_at,
            })

        # ── Bulk export ──────────────────────────────────────────────────────
        if max_result >= RESULT_COUNT_WARNING:
            alerts.append({
                'labels': {
                    'alertname': 'MCPUserBulkExport',
                    'severity':  'warning',
                    'user':      email,
                    'entity':    entities,
                },
                'annotations': {
                    'summary':     f'Bulk export detected: {email}',
                    'description': (
                        f'{email} ran a search returning {max_result} records in a single call in the last hour. '
                        f'Entities: {entities}. '
                        f'To investigate, run on the MCP server: {investigate}'
                    ),
                },
                'startsAt': starts_at,
                'endsAt':   ends_at,
            })

    return alerts


def fire_alerts(alerts):
    """POST alerts to Alertmanager. Returns count fired."""
    if not alerts:
        return 0
    payload = json.dumps(alerts).encode()
    req = urllib.request.Request(
        f'{ALERTMANAGER}/api/v2/alerts',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status not in (200, 204):
                print(f'[WARN] Alertmanager returned HTTP {resp.status}', file=sys.stderr)
    except Exception as e:
        print(f'[ERROR] Could not reach Alertmanager: {e}', file=sys.stderr)
        return 0
    return len(alerts)


def main():
    until  = now_utc()
    since  = until - timedelta(minutes=WINDOW_MINUTES)
    rows   = query_db(since.isoformat(), until.isoformat())

    if not rows:
        print(f'[INFO] No audit data in window ({since.strftime("%H:%M")}–{until.strftime("%H:%M")} UTC)')
        return

    user_stats = analyse(rows)
    alerts     = build_alerts(user_stats, since, until)
    fired      = fire_alerts(alerts)

    if fired:
        names = ', '.join(sorted({a['labels']['alertname'] for a in alerts}))
        users = ', '.join(sorted({a['labels']['user'] for a in alerts}))
        print(f'[ALERT] {fired} alert(s) fired — {names} — users: {users}')
    else:
        print(f'[OK] {len(user_stats)} user(s) checked, no thresholds exceeded')


if __name__ == '__main__':
    main()
