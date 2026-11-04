"""-V and --version are a version request only before the command (the npm package follows the same rule:
packages/zn-gate/test/version_flag_position.test.js runs the same corpus)."""
import sys

import pytest

from zn_gate import cli

# (arguments, exit code, kind of output)
CORPUS = [
    (["-V"], 0, "version"),
    (["--version"], 0, "version"),
    (["-V", "scan", "."], 0, "version"),
    (["--version", "status"], 0, "version"),
    (["scan", ".", "-V"], 2, "unknown option"),
    (["status", "--version"], 2, "unknown option"),
]


@pytest.mark.parametrize("args,code,kind", CORPUS, ids=[" ".join(c[0]) for c in CORPUS])
def test_version_flag_position(monkeypatch, tmp_path, capsys, args, code, kind):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["zn-gate", *args])
    with pytest.raises(SystemExit) as exc:
        cli.main()
    assert exc.value.code == code
    out = capsys.readouterr()
    if kind == "version":
        assert out.out.startswith("zn-gate ")
    else:
        assert out.out == ""
        assert "unrecognized arguments" in out.err
