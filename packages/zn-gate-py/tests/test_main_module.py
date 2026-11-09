import subprocess
import sys


def test_python_m_zn_gate_runs_the_cli():
    r = subprocess.run([sys.executable, "-m", "zn_gate", "--version"], capture_output=True, text=True)
    assert r.returncode == 0
    assert r.stdout.startswith("zn-gate ")


def test_python_m_zn_gate_help_matches_the_script():
    r = subprocess.run([sys.executable, "-m", "zn_gate", "--help"], capture_output=True, text=True)
    assert r.returncode == 0
    assert "scan" in r.stdout


def _run_zn_gate_m(*args):
    return subprocess.run(
        [sys.executable, "-m", "zn_gate", *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_python_m_zn_gate_help_exits_0_with_usage_on_stdout_only():
    proc = _run_zn_gate_m("--help")
    assert proc.returncode == 0
    assert proc.stdout.startswith("usage: zn-gate")
    assert proc.stderr == ""


def test_python_m_zn_gate_help_lists_every_subcommand():
    from zn_gate.cli import build_parser, known_commands

    proc = _run_zn_gate_m("--help")
    for name in sorted(known_commands(build_parser())):
        assert name in proc.stdout


def test_python_m_zn_gate_help_matches_python_m_zn_gate_cli():
    cli = subprocess.run(
        [sys.executable, "-m", "zn_gate.cli", "--help"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert _run_zn_gate_m("--help").stdout == cli.stdout


def test_python_m_zn_gate_unknown_command_exits_1_with_hint_on_stderr():
    proc = _run_zn_gate_m("frobnicate")
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "Unknown command: frobnicate" in proc.stderr
    assert "zn-gate --help" in proc.stderr
