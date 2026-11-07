"""Top rules in the Python stats: same ids, order and windows as the Node package, ids and counts only."""

import datetime
import json

from zn_gate import stats

NOW = datetime.date(2026, 10, 14)


def write(tmp_path, days):
    path = tmp_path / "stats.json"
    path.write_text(json.dumps({"version": 1, "days": days, "events": {}}))
    return str(path)


def entry(detections):
    return {"checked": 5, "blocked": 1, "warned": 0, "redacted": 1, "detections": detections}


def ledger(tmp_path):
    return write(tmp_path, {
        "2026-10-13": {"hook:claude-code": entry({"AWS_KEY": 6, "GITHUB_TOKEN": 4, "DB_PASSWORD": 4, "JWT": 3})},
        "2026-10-12": {"hook:cursor": entry({"AWS_KEY": 3, "EMAIL": 2, "SSN": 1})},
        "2026-10-04": {"hook:cursor": entry({"STRIPE_KEY": 50})},
    })


def test_top_rules_order_limit_and_window(tmp_path):
    path = ledger(tmp_path)
    top = stats.top_rules(now=NOW, path=path)
    assert [(r["id"], r["count"]) for r in top] == [
        ("AWS_KEY", 9), ("DB_PASSWORD", 4), ("GITHUB_TOKEN", 4), ("JWT", 3), ("EMAIL", 2)]
    assert stats.top_rules(days=30, now=NOW, path=path)[0]["id"] == "STRIPE_KEY"


def test_render_shows_block_and_hint_with_ids_only(tmp_path):
    path = ledger(tmp_path)
    s = stats.summary(days=30, now=NOW, path=path)
    text = stats.render(s, {"days": 7, "rules": stats.top_rules(now=NOW, path=path)})
    assert "Top rules, last 7 days:" in text
    assert text.index("AWS_KEY  ") < text.index("DB_PASSWORD  ") < text.index("GITHUB_TOKEN  ")
    assert "Most frequent: AWS_KEY. To understand a block, see https://usezn.com/docs/" in text
    assert "SSN  " not in text


def test_render_without_top_is_unchanged(tmp_path):
    s = stats.summary(days=30, now=NOW, path=ledger(tmp_path))
    assert "Top rules" not in stats.render(s)
