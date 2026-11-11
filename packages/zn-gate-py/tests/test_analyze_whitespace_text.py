"""Python analyze and whitespace-only text: it should be refused like empty text (exit 2, usage message).
Today the empty string is refused, but spaces or newlines only are allowed. Values are invented; the check runs
local rules only (--local-only), with no network call and no key."""
import os
import subprocess
import sys

import pytest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def _env(home):
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["HOME"] = str(home)
    for name in ("ZN_CLOUD", "ZN_API_KEY", "ZN_API_URL", "ZN_STAGE"):
        env.pop(name, None)
    return env


def test_analyze_empty_text_is_still_a_usage_error(tmp_path):
    proc = subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "analyze", "", "--local-only"],
        capture_output=True, text=True, env=_env(tmp_path), timeout=60,
    )
    assert proc.returncode == 2, proc.stdout
    assert "usage:" in proc.stderr


@pytest.mark.xfail(
    strict=True,
    reason="analyze accepts whitespace-only text: 'zn-gate analyze \"   \"' exits 0 with verdict allow "
           "(only the empty string is refused with exit 2). Remove this marker when it is refused.",
)
@pytest.mark.parametrize("text", ["   ", "\n  \t\n"])
def test_analyze_whitespace_only_text_is_a_usage_error(text, tmp_path):
    proc = subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "analyze", text, "--local-only"],
        capture_output=True, text=True, env=_env(tmp_path), timeout=60,
    )
    assert proc.returncode == 2, proc.stdout
    assert proc.stdout == ""
    assert "usage:" in proc.stderr
