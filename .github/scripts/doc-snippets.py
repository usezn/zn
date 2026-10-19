#!/usr/bin/env python3
"""Run the code blocks of the docs that are marked as runnable, against the packages built from this commit.

  doc-snippets.py list                list every fenced block (marked and not) and why it would not run
  doc-snippets.py run [--netns]       build the packages, then run each marked block offline

A block runs only when the line above its opening fence (blank lines allowed in between) is the marker

    <!-- snippet-test -->

An HTML comment renders as nothing on GitHub and npm. Supported languages: javascript (js), python (py) and
bash (sh). Scanned files: README.md, packages/*/README.md and docs/*.md. A marker with no fence after it, or
on a block of another language, is an error, so a marker cannot silently stop working.

How a block runs: in a fresh directory, with an empty environment (no API key, no cloud credential, a
throwaway HOME), and with the network blocked (with --netns the process runs in an empty network namespace
through sudo unshare, as the examples smoke job does). Python runs in a virtual environment with the
zn-gate package installed from packages/zn-gate-py; javascript and bash run in a project that has the zn-gate
tarball made by `npm pack` of packages/zn-gate installed, with its bin on PATH. Each block must exit 0 within
the time limit. Blocks do not share state. Stdlib only.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MARKER = re.compile(r"^\s*<!--\s*snippet-test\s*-->\s*$")
FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})\s*([\w+-]*)")
LANGS = {"javascript": "js", "js": "js", "python": "py", "py": "py", "bash": "sh", "sh": "sh", "shell": "sh"}
STEP_TIMEOUT = 900
RUN_TIMEOUT = 90


def doc_files():
    files = [ROOT / "README.md"]
    files += sorted(ROOT.glob("packages/*/README.md"))
    files += sorted((ROOT / "docs").glob("*.md"))
    return [f for f in files if f.is_file()]


def is_close(line, fence):
    stripped = line.strip()
    return len(stripped) >= len(fence) and set(stripped) == {fence[0]}


def parse(path):
    """Return the fenced blocks of a file (file, line, lang, code, marked) and the marker errors."""
    lines = path.read_text(encoding="utf-8").split("\n")
    rel = path.relative_to(ROOT).as_posix()
    blocks, errors = [], []
    pending = None  # line number of a marker waiting for its fence
    i = 0
    while i < len(lines):
        line = lines[i]
        fence = FENCE.match(line)
        if fence:
            lang = fence.group(3).lower()
            body, j = [], i + 1
            while j < len(lines) and not is_close(lines[j], fence.group(2)):
                body.append(lines[j])
                j += 1
            indent = len(fence.group(1))
            code = "\n".join(b[indent:] if b[:indent].strip() == "" else b for b in body) + "\n"
            blocks.append({"file": rel, "line": i + 1, "lang": lang, "code": code, "marked": pending is not None})
            if pending is not None and lang not in LANGS:
                errors.append(f"{rel}:{pending}: snippet-test marker on a '{lang}' block; only javascript, python and bash can run")
            pending = None
            i = j + 1
            continue
        if MARKER.match(line):
            if pending is not None:
                errors.append(f"{rel}:{pending}: snippet-test marker is not followed by a code block")
            pending = i + 1
        elif line.strip() and pending is not None:
            errors.append(f"{rel}:{pending}: snippet-test marker is not followed by a code block")
            pending = None
        i += 1
    if pending is not None:
        errors.append(f"{rel}:{pending}: snippet-test marker is not followed by a code block")
    return blocks, errors


def collect():
    blocks, errors = [], []
    for f in doc_files():
        b, e = parse(f)
        blocks += b
        errors += e
    return blocks, errors


def skip_reason(block):
    if block["lang"] not in LANGS:
        return f"not a runnable language ({block['lang'] or 'no language'})"
    if not block["marked"]:
        return "not marked"
    return None


def cmd_list():
    blocks, errors = collect()
    for e in errors:
        print(f"::error::{e}")
    todo = [b for b in blocks if skip_reason(b) is None]
    print(f"{len(blocks)} blocks, {len(todo)} marked to run")
    for b in blocks:
        reason = skip_reason(b)
        print(f"  {b['file']}:{b['line']} {b['lang'] or '-'}: {'RUN' if reason is None else 'skip - ' + reason}")
    return 1 if errors else 0


def clean_env(home, extra_path):
    node = shutil.which("node")
    path = [*extra_path, *([str(Path(node).parent)] if node else []), "/usr/bin", "/bin"]
    # A whitelist: no API key or cloud credential from the runner reaches a block.
    return {
        "PATH": ":".join(dict.fromkeys(path)),
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NO_COLOR": "1",
        "npm_config_offline": "true",
        "npm_config_audit": "false",
        "npm_config_fund": "false",
        "npm_config_update_notifier": "false",
        "npm_config_cache": str(home / ".npm"),
    }


def build(work):
    """Install the zn-gate packages of this checkout. The network is allowed here and nowhere after."""
    npm_src = work / "zn-gate-src"
    shutil.copytree(ROOT / "packages" / "zn-gate", npm_src, ignore=shutil.ignore_patterns("node_modules"))
    subprocess.run(["npm", "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=npm_src, check=True, timeout=STEP_TIMEOUT)
    packed = subprocess.run(["npm", "pack", "--silent", "--pack-destination", str(work)], cwd=npm_src, check=True,
                            capture_output=True, text=True, timeout=STEP_TIMEOUT).stdout.strip().splitlines()[-1]
    project = work / "project"
    project.mkdir()
    (project / "package.json").write_text('{"name":"doc-snippets","version":"0.0.0","private":true}\n', encoding="utf-8")
    # The tarball bundles its one dependency, so this install needs no registry.
    subprocess.run(["npm", "install", "--offline", "--no-audit", "--no-fund", str(work / packed)], cwd=project,
                   check=True, timeout=STEP_TIMEOUT)
    py_src = work / "zn-gate-py"
    shutil.copytree(ROOT / "packages" / "zn-gate-py", py_src, ignore=shutil.ignore_patterns("build", "*.egg-info", "__pycache__"))
    venv = work / "venv"
    subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True, timeout=STEP_TIMEOUT)
    subprocess.run([str(venv / "bin" / "python"), "-m", "pip", "install", "-q", str(py_src)], check=True, timeout=STEP_TIMEOUT)
    return project, venv


def run_block(block, index, work, project, venv, netns):
    lang = LANGS[block["lang"]]
    home = work / f"home-{index}"
    home.mkdir()
    # Node and bash run inside the project so require() and npx find the installed package.
    cwd = (work / f"cwd-{index}") if lang == "py" else (project / f"snippet-{index}")
    cwd.mkdir()
    script = cwd / {"js": "snippet.js", "py": "snippet.py", "sh": "snippet.sh"}[lang]
    script.write_text(block["code"], encoding="utf-8")
    env = clean_env(home, [str(venv / "bin"), str(project / "node_modules" / ".bin")])
    argv = {"js": ["node", str(script)],
            "py": [str(venv / "bin" / "python"), "-I", str(script)],
            "sh": ["bash", "-e", "-o", "pipefail", str(script)]}[lang]
    command = ["env", "-i", *[f"{k}={v}" for k, v in env.items()], *argv]
    if netns:
        # Empty network namespace, run as the current user rather than as root.
        command = ["sudo", "-n", "unshare", "-n", "setpriv", f"--reuid={os.getuid()}", f"--regid={os.getgid()}",
                   "--clear-groups", *command]
    start = time.time()
    try:
        proc = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=RUN_TIMEOUT)
        code, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        code, out, err = 124, "", f"timed out after {RUN_TIMEOUT} s"
    return code, out, err, time.time() - start


def cmd_run(netns):
    blocks, errors = collect()
    for e in errors:
        print(f"::error::{e}")
    if errors:
        return 1
    todo = [b for b in blocks if skip_reason(b) is None]
    skipped = [b for b in blocks if skip_reason(b) is not None]
    started = time.time()
    work = Path(tempfile.mkdtemp(prefix="doc-snippets-"))
    failures, rows = [], []
    try:
        print("::group::Build the packages")
        project, venv = build(work)
        print("::endgroup::")
        for n, b in enumerate(todo):
            where = f"{b['file']}:{b['line']}"
            code, out, err, secs = run_block(b, n, work, project, venv, netns)
            print(f"::group::{where} ({b['lang']}) exit {code} in {secs:.1f} s")
            print(b["code"], end="")
            print("--- output")
            print(out, end="")
            if err.strip():
                print(err, end="")
            print("::endgroup::")
            rows.append((where, b["lang"], "PASS" if code == 0 else f"FAIL (exit {code})", secs))
            if code != 0:
                failures.append(where)
                print(f"::error file={b['file']},line={b['line']}::this documented snippet failed (exit {code}); "
                      f"fix the snippet or the package")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    reasons = {}
    for b in skipped:
        reasons.setdefault(skip_reason(b), []).append(b)
    lines = [f"Executed {len(rows)} block(s), {len(failures)} failed, skipped {len(skipped)}, "
             f"total {time.time() - started:.0f} s", ""]
    lines += [f"- {w} {lang}: {res} ({s:.1f} s)" for w, lang, res, s in rows]
    lines += ["", "Skipped:"]
    for reason, items in sorted(reasons.items()):
        lines.append(f"- {reason}: {len(items)}")
        if reason == "not marked":
            lines += [f"    {b['file']}:{b['line']} ({b['lang']})" for b in items]
    summary = "\n".join(lines)
    print(summary)
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as fh:
            fh.write("### Doc snippets\n\n```\n" + summary + "\n```\n")
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    return 0


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "list":
        return cmd_list()
    if command == "run":
        return cmd_run("--netns" in argv)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
