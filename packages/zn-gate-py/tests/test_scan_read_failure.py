"""A file that passes the readability check but whose read then fails is reported as not read, never as a clean
file, so the scan is incomplete (exit 3), like the npm package. Temporary folder, fake text only."""
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace

from zn_gate import cli


def _ns(path, fmt="json"):
    return SimpleNamespace(path=str(path), format=fmt, no_fail=False, allow_partial=False, include_home=False)


def _run(tmp_path, monkeypatch, fmt="json"):
    (tmp_path / "ok.md").write_text("Plain notes.\n")
    (tmp_path / "flaky.md").write_text("Plain notes too.\n")
    real = Path.read_bytes

    def read_bytes(self):
        if self.name == "flaky.md":
            raise OSError(5, "Input/output error")
        return real(self)

    monkeypatch.setattr(Path, "read_bytes", read_bytes)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli.cmd_scan(_ns(tmp_path, fmt))
    return code, out.getvalue()


def test_a_file_whose_read_fails_is_reported_as_not_read(tmp_path, monkeypatch):
    code, text = _run(tmp_path, monkeypatch)
    assert code == 3, text
    report = json.loads(text)
    skipped = json.dumps(report)
    assert "flaky.md" in skipped and "cannot be read" in skipped, skipped


def test_the_text_report_does_not_call_the_scan_clean(tmp_path, monkeypatch):
    code, text = _run(tmp_path, monkeypatch, fmt="text")
    assert code == 3
    assert "cannot be read" in text
