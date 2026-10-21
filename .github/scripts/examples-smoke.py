#!/usr/bin/env python3
"""Smoke test for the Python examples that pin zn-gate in examples/<name>/requirements.txt.

  examples-smoke.py markers                       check every .requires-next marker against its pin
  examples-smoke.py run [--netns] [--only NAME]   check the markers, then install each example and run it offline

An example runs against the zn-gate version its requirements.txt pins. If it uses an API that is not in
that release yet, it has a marker file examples/<name>/.requires-next holding the release that first ships
the API (for example 1.13.0). Such an example runs against packages/zn-gate-py (this repository) instead of
the pin, and the job prints a notice. The marker must go once the pin reaches that release: `markers` fails
when the pin is at or above the marker, so a release cannot forget it.

Each example runs its agent_guard.py with the network blocked (sockets refuse in Python, and with --netns the
process runs in an empty network namespace), with no API keys in its environment, and with the framework
installed from its requirements. Stdlib only.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples"
LOCAL = ROOT / "packages" / "zn-gate-py"
MARKER = ".requires-next"
PIN = re.compile(r"^zn-gate==(\d+\.\d+\.\d+)\s*$", re.M)
VERSION = re.compile(r"\d+\.\d+\.\d+")
# Text the example's main() must print: the page is read through the guard, a secret is hidden, and the
# framework was found (the job installs it, so "is not installed" means the install did not work).
EXPECTED = ["model reads: Paris today", "zn-gate blocked", "[REDACTED_AWS_KEY]"]
FORBIDDEN = ["is not installed"]
STEP_TIMEOUT = 900
RUN_TIMEOUT = 120


def version_tuple(text):
    return tuple(int(part) for part in text.split("."))


def example_dirs():
    return sorted(path.parent for path in EXAMPLES.glob("*/requirements.txt"))


def pin_of(example):
    text = (example / "requirements.txt").read_text(encoding="utf-8")
    found = PIN.findall(text)
    if len(found) != 1:
        raise SystemExit(f"ABORT examples/{example.name}/requirements.txt must hold exactly one zn-gate== pin")
    return found[0]


def marker_of(example):
    path = example / MARKER
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    if not VERSION.fullmatch(text):
        raise SystemExit(f"ABORT examples/{example.name}/{MARKER} must hold one release version, for example 1.13.0")
    return text


def check_markers():
    errors = []
    for example in example_dirs():
        marker = marker_of(example)
        if marker is None:
            continue
        pin = pin_of(example)
        if version_tuple(pin) >= version_tuple(marker):
            errors.append(
                f"examples/{example.name}: {MARKER} says {marker} but the pin is already {pin}. "
                f"Remove the marker and run the examples against the pin."
            )
    return errors


def smoke_env(home):
    # A whitelist: no API key or cloud credential from the runner can reach an example.
    keep = {"PATH": "/usr/bin:/bin"}
    return {
        **keep,
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "OTEL_SDK_DISABLED": "true",
        "CREWAI_DISABLE_TELEMETRY": "1",
        "ANONYMIZED_TELEMETRY": "false",
        "DO_NOT_TRACK": "1",
    }


def audit_example(name, venv):
    """Report-only advisory check of everything installed for one example (the frameworks pull in unpinned
    transitive dependencies). Runs when ZN_EXAMPLES_AUDIT=1 and pip-audit is on PATH; never fails the smoke."""
    tool = shutil.which("pip-audit")
    if os.environ.get("ZN_EXAMPLES_AUDIT") != "1" or not tool:
        return
    site = sorted(venv.glob("lib/python*/site-packages"))
    if not site:
        print(f"::warning title=Example dependency audit::examples/{name}: site-packages not found, not audited")
        return
    try:
        proc = subprocess.run([tool, "--path", str(site[0]), "--format", "json", "--progress-spinner", "off"],
                              capture_output=True, text=True, timeout=STEP_TIMEOUT)
        report = json.loads(proc.stdout or "{}")
    except (subprocess.TimeoutExpired, ValueError) as exc:
        print(f"::warning title=Example dependency audit::examples/{name}: audit did not finish ({exc.__class__.__name__})")
        return
    found = 0
    for dep in report.get("dependencies", []):
        for vuln in dep.get("vulns", []):
            found += 1
            fix = ", ".join(vuln.get("fix_versions") or []) or "no fixed version yet"
            print(f"::warning title=Example dependency advisory::examples/{name}: {dep.get('name')} "
                  f"{dep.get('version')} {vuln.get('id')} (fixed in: {fix})")
    print(f"examples/{name}: dependency audit found {found} advisor{'y' if found == 1 else 'ies'}")


def run_example(example, netns):
    name = example.name
    marker = marker_of(example)
    work = Path(tempfile.mkdtemp(prefix=f"examples-smoke-{name}-"))
    try:
        venv = work / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True, timeout=STEP_TIMEOUT)
        py = str(venv / "bin" / "python")
        if marker:
            pin = pin_of(example)
            print(f"::notice title=Unreleased zn-gate API::examples/{name} needs zn-gate {marker} "
                  f"(its API is not in the pinned {pin}), so it runs against packages/zn-gate-py")
            lines = (example / "requirements.txt").read_text(encoding="utf-8").splitlines()
            rest = work / "requirements.txt"
            rest.write_text("\n".join(x for x in lines if not x.startswith("zn-gate==")) + "\n", encoding="utf-8")
            # A copy, so the build leaves no files in the checkout.
            local = work / "zn-gate-py"
            shutil.copytree(LOCAL, local, ignore=shutil.ignore_patterns("build", "*.egg-info", "__pycache__"))
            subprocess.run([py, "-m", "pip", "install", "-q", "-r", str(rest)], check=True, timeout=STEP_TIMEOUT)
            subprocess.run([py, "-m", "pip", "install", "-q", str(local)], check=True, timeout=STEP_TIMEOUT)
        else:
            subprocess.run([py, "-m", "pip", "install", "-q", "-r", str(example / "requirements.txt")],
                           check=True, timeout=STEP_TIMEOUT)
        audit_example(name, venv)
        env = smoke_env(work)
        command = ["env", "-i", *[f"{k}={v}" for k, v in env.items()],
                   py, "-I", str(Path(__file__).resolve()), "_exec", str(example / "agent_guard.py")]
        if netns:
            command = ["sudo", "-n", "unshare", "-n", *command]
        proc = subprocess.run(command, cwd=str(example), capture_output=True, text=True, timeout=RUN_TIMEOUT)
        print(proc.stdout, end="")
        if proc.stderr.strip():
            print(proc.stderr, end="", file=sys.stderr)
        problems = []
        if proc.returncode != 0:
            problems.append(f"exit code {proc.returncode}")
        problems += [f"missing output: {text!r}" for text in EXPECTED if text not in proc.stdout]
        problems += [f"unexpected output: {text!r}" for text in FORBIDDEN if text in proc.stdout]
        return problems
    finally:
        shutil.rmtree(work, ignore_errors=True)


def exec_offline(path):
    # Runs one agent_guard.py with every socket connection refused, as a plain script would run.
    import runpy
    import socket

    def refuse(*args, **kwargs):
        raise OSError("network is blocked in the examples smoke")

    socket.socket.connect = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse
    sys.argv = [path]
    runpy.run_path(path, run_name="__main__")


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "_exec":
        exec_offline(argv[2])
        return 0
    if command == "markers":
        errors = check_markers()
        for error in errors:
            print(f"::error::{error}")
        print("markers OK" if not errors else f"{len(errors)} stale marker(s)")
        return 1 if errors else 0
    if command != "run":
        print(__doc__)
        return 2
    netns = "--netns" in argv
    only = argv[argv.index("--only") + 1] if "--only" in argv else None
    errors = check_markers()
    if errors:
        for error in errors:
            print(f"::error::{error}")
        return 1
    failed = []
    for example in example_dirs():
        if only and example.name != only:
            continue
        print(f"::group::examples/{example.name}")
        try:
            problems = run_example(example, netns)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            problems = [f"a step failed: {error}"]
        print("::endgroup::")
        if problems:
            failed.append(example.name)
            for problem in problems:
                print(f"::error::examples/{example.name}: {problem}")
        else:
            print(f"examples/{example.name}: OK")
    if failed:
        print(f"FAILED: {', '.join(failed)}")
        return 1
    print("all examples OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
