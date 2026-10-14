import datetime
import json
import subprocess
import sys

from zn_gate import stats


def write(tmp_path, days):
    (tmp_path / "stats.json").write_text(json.dumps({"version": 1, "days": days, "events": {}}))


def test_summary_counts_window_and_types(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    write(tmp_path, {
        "2026-10-14": {"hook:codex": {"checked": 3, "blocked": 1, "warned": 0, "redacted": 2, "detections": {"AWS_KEY": 2}}},
        "2026-10-13": {"mcp:mcp-client": {"checked": 1, "blocked": 0, "warned": 0, "redacted": 1, "detections": {"GITHUB_TOKEN": 1}}},
        "2026-08-01": {"hook:codex": {"checked": 50, "blocked": 0, "warned": 0, "redacted": 0, "detections": {}}},
    })
    s = stats.summary(days=30, now=datetime.date(2026, 10, 14))
    assert s["total"] == {"checked": 4, "blocked": 1, "warned": 0, "redacted": 3}
    assert s["detections"] == {"AWS_KEY": 2, "GITHUB_TOKEN": 1}
    assert s["since"] == "2026-10-13"
    text = stats.render(s)
    assert "4 checks" in text and "AWS_KEY 2" in text and "codex (agent hooks)" in text
    assert "stay on this machine" in text


def test_missing_or_corrupt_file(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    assert stats.summary()["total"]["checked"] == 0
    (tmp_path / "stats.json").write_text("{not json")
    assert "Nothing recorded yet" in stats.render(stats.summary())


def test_cli_stats_json(tmp_path, monkeypatch):
    monkeypatch.setenv("ZN_HOME", str(tmp_path))
    today = datetime.datetime.utcnow().date().isoformat()
    write(tmp_path, {today: {"hook:claude-code": {"checked": 2, "blocked": 1, "warned": 0, "redacted": 0, "detections": {}}}})
    out = subprocess.run([sys.executable, "-m", "zn_gate.cli", "stats", "--json"], capture_output=True, text=True, check=True).stdout
    assert json.loads(out)["total"]["checked"] == 2
