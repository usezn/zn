"""Plain wording of two warnings: a failed cloud call and a damaged evidence log."""
import io
import urllib.error
from unittest import mock

import pytest

from zn_gate import client, evidence


def _warning(exc, monkeypatch):
    monkeypatch.setenv("ZN_CLOUD", "1")
    monkeypatch.setenv("ZN_VERBOSE", "1")
    err = io.StringIO()
    with mock.patch.object(client, "analyze_cloud", side_effect=exc), mock.patch("sys.stderr", err):
        res = client.analyze("hello there", api_key="zn-test-fake-0000")
    assert res["fallback"] is True
    return err.getvalue()


@pytest.mark.parametrize("exc,hint", [
    (urllib.error.HTTPError("http://example.invalid", 401, "Unauthorized", None, None), "did not accept the API key"),
    (urllib.error.URLError(ConnectionRefusedError(111, "refused")), "could not be reached"),
    (urllib.error.URLError(TimeoutError("timed out")), "took too long"),
    (ValueError("odd"), "The cloud check failed."),
])
def test_cloud_warning_says_what_to_do(exc, hint, monkeypatch):
    text = _warning(exc, monkeypatch)
    assert hint in text
    assert "checked on this machine only" in text
    assert "zn-test-fake-0000" not in text


def test_damaged_evidence_warning_is_two_sentences(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(evidence, "_last_warn", None)
    log = tmp_path / "evidence.jsonl"
    log.write_text("{bad json\n")
    assert evidence.log_evidence({"verdict": "allow"}, str(log)) is None
    err = capsys.readouterr().err
    assert "is damaged (" in err
    assert "). Events are not being recorded." in err
