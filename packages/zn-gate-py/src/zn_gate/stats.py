"""Local counts of what zn-gate did on this machine (`zn-gate stats`), read-only.

The counts live in ~/.zn/stats.json (ZN_HOME overrides ~/.zn), written by the npm package (agent hooks, MCP tools
and the shield proxy). They are numbers only: no values, prompts, paths or hosts. Nothing is sent from here;
opt-in sharing of pseudonymous daily counts is managed with the npm package (`npx zn-gate stats share`).
"""

import datetime
import json
import os
from typing import Any, Dict, Optional

KEEP_DAYS = 90
LAYER_NAMES = {
    "hook": "agent hooks",
    "shield": "shield (wrapped MCP servers)",
    "mcp": "MCP tools",
    "broker": "secrets broker",
    "cli": "command line",
}


def stats_file() -> str:
    home = os.environ.get("ZN_HOME")
    base = os.path.abspath(home) if home else os.path.join(os.path.expanduser("~"), ".zn")
    return os.path.join(base, "stats.json")


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


def render(s: Dict[str, Any]) -> str:
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
