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
