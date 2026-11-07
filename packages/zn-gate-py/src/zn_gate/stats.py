"""Local counts of what zn-gate did on this machine (`zn-gate stats`), read-only.

The counts live in ~/.zn/stats.json (ZN_HOME overrides ~/.zn), written by the npm package (agent hooks, MCP tools
and the shield proxy). They are numbers only: no values, prompts, paths or hosts. Nothing is sent from here;
opt-in sharing of pseudonymous daily counts is managed with the npm package (`npx zn-gate stats share`).
"""

import datetime
import json
import os
from typing import Any, Dict, List, Optional

KEEP_DAYS = 90
LAYER_NAMES = {
    "hook": "agent hooks",
    "shield": "shield (wrapped MCP servers)",
    "mcp": "MCP tools",
    "broker": "secrets broker",
    "cli": "command line",
}


def zn_home() -> str:
    """~/.zn, or the folder ZN_HOME names (the same rule as the npm package)."""
    home = os.environ.get("ZN_HOME")
    return os.path.abspath(home) if home else os.path.join(os.path.expanduser("~"), ".zn")


def stats_file() -> str:
    return os.path.join(zn_home(), "stats.json")


def load(path: Optional[str] = None) -> Dict[str, Any]:
    try:
        with open(path or stats_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("days"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "days": {}, "events": {}}


def _num(v: Any) -> int:
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def summary(days: int = 30, now: Optional[datetime.date] = None, path: Optional[str] = None) -> Dict[str, Any]:
    today = now or datetime.datetime.now(datetime.timezone.utc).date()
    cutoff = (today - datetime.timedelta(days=days - 1)).isoformat()
    data = load(path)
    total = {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0}
    by_key: Dict[str, Dict[str, int]] = {}
    detections: Dict[str, int] = {}
    first = None
    for day, entries in data.get("days", {}).items():
        if day < cutoff or not isinstance(entries, dict):
            continue
        if first is None or day < first:
            first = day
        for key, c in entries.items():
            if not isinstance(c, dict):
                continue
            k = by_key.setdefault(key, {"checked": 0, "blocked": 0, "warned": 0, "redacted": 0})
            for f in total:
                n = _num(c.get(f))
                total[f] += n
                k[f] += n
            dets = c.get("detections")
            for t, n in (dets.items() if isinstance(dets, dict) else []):
                detections[t] = detections.get(t, 0) + _num(n)
    return {"days": days, "since": first, "total": total, "byKey": by_key, "detections": detections,
            "events": dict(data.get("events") or {})}


TOP_RULES_DAYS = 7
TOP_RULES_LIMIT = 5
GENERIC_RULE_NAME = "Built-in detector"
WHY_HINT = "To understand a block, see https://usezn.com/docs/zn-gate/troubleshooting/"


def top_rules(days: int = TOP_RULES_DAYS, limit: int = TOP_RULES_LIMIT, now: Optional[datetime.date] = None,
              path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Most frequent detector ids over the last `days` days: ids and counts only, highest count first, ties by id."""
    dets = summary(days=days, now=now, path=path)["detections"]
    items = sorted(((t, n) for t, n in dets.items() if n > 0), key=lambda kv: (-kv[1], kv[0]))[:limit]
    return [{"id": t, "name": GENERIC_RULE_NAME, "count": n} for t, n in items]


def render(s: Dict[str, Any], top: Optional[Dict[str, Any]] = None) -> str:
    t = s["total"]
    lines = ["zn-gate on this machine, last {} day{}{}:".format(
        s["days"], "" if s["days"] == 1 else "s", " (counting since {})".format(s["since"]) if s["since"] else ""), ""]
    if not any(t.values()):
        lines.append("  Nothing recorded yet. Counts are written by zn-gate's agent hooks, MCP tools and shield proxy (npm package).")
    else:
        lines.append("  {:,} events checked (prompts, tool calls and tool results)".format(t["checked"]))
        lines.append("  {:,} blocked (a secret file read, a pasted secret, a prompt injection or a risky call)".format(t["blocked"]))
        lines.append("  {:,} secret values replaced before the model saw them".format(t["redacted"]))
        if t["warned"]:
            lines.append("  {:,} warnings".format(t["warned"]))
        types = sorted(s["detections"].items(), key=lambda kv: -kv[1])[:8]
        if types:
            lines.append("")
            lines.append("  Secret types found: " + ", ".join("{} {:,}".format(k, n) for k, n in types))
        rules = (top or {}).get("rules") or []
        if rules:
            d = (top or {})["days"]
            lines.append("")
            lines.append("  Top rules, last {} day{}:".format(d, "" if d == 1 else "s"))
            for r in rules:
                lines.append("    {}  {}  {:,}".format(r["id"], r["name"], r["count"]))
            lines.append("  Most frequent: {}. {}".format(rules[0]["id"], WHY_HINT))
        if s["byKey"]:
            lines.append("")
            lines.append("  By agent:")
            for key, c in sorted(s["byKey"].items(), key=lambda kv: -kv[1]["checked"]):
                layer, _, agent = key.partition(":")
                lines.append("    {} ({}): {:,} events, {:,} blocked, {:,} replaced".format(
                    agent, LAYER_NAMES.get(layer, layer), c["checked"], c["blocked"], c["redacted"]))
    lines.append("")
    lines.append("  These counts stay on this machine. Sharing pseudonymous daily counts is opt-in: `npx zn-gate stats share show`.")
    return "\n".join(lines) + "\n"
