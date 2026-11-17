"""Start-up cost guards: the local path must not load the cloud client or compile every rule."""

import json
import os
import subprocess
import sys

import pytest


def _run(code: str) -> str:
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, env=env)
    return proc.stdout.strip()


def test_import_does_not_load_the_cloud_client():
    code = (
        "import sys, zn_gate\n"
        "zn_gate.check_tool_call('Bash', {'command': 'ls'})\n"
        "print(json.dumps([m for m in ('zn_gate.client', 'ssl', 'http.client', 'urllib.request', 'zn_gate.integrations') if m in sys.modules]))"
    ).replace("json.dumps", "__import__('json').dumps")
    assert json.loads(_run(code)) == []


def test_client_names_still_resolve_lazily():
    code = (
        "import sys, zn_gate\n"
        "assert 'zn_gate.client' not in sys.modules\n"
        "from zn_gate import analyze, is_cloud_enabled\n"
        "assert 'zn_gate.client' in sys.modules\n"
        "assert analyze is zn_gate.client.analyze and callable(is_cloud_enabled)\n"
        "assert 'analyze' in dir(zn_gate)\n"
        "print('ok')"
    )
    assert _run(code) == "ok"


def test_unknown_attribute_still_raises():
    import zn_gate

    with pytest.raises(AttributeError):
        zn_gate.not_a_real_name  # noqa: B018


def test_adapters_load_only_when_used():
    code = (
        "import sys\n"
        "from zn_gate.integrations import guarded_tool\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('zn_gate.integrations.'))\n"
        "print(','.join(loaded))"
    )
    assert _run(code) == "zn_gate.integrations.crewai"


def test_rules_are_not_compiled_at_import():
    code = (
        "import re, zn_gate.rules as r\n"
        "real = re.compile\n"
        "calls = []\n"
        "re.compile = lambda *a, **k: (calls.append(a[0]), real(*a, **k))[1]\n"
        "import importlib; importlib.reload(r)\n"
        "print(len(calls))"
    )
    # Importing defines the patterns without compiling them.
    assert int(_run(code)) <= 5


def test_rule_compiles_on_first_use_and_matches_like_a_real_pattern():
    import re

    from zn_gate import rules

    lazy = rules.ZERO_WIDTH_RE
    assert lazy.pattern == r"[\u0000-\u0008\u000E-\u001A\u001C-\u001F\u200B-\u200D\u2060\uFEFF\u00AD\uFE00-\uFE0F\u061C\u180E\u200E\u200F\u115F\u1160\u3164\uFFA0]"
    assert lazy.sub("", "a\u200bb") == "ab"
    assert lazy.search("x") is None
    assert lazy.search("a\u200bb").group() == "\u200b"
    assert isinstance(lazy.sub, type(re.compile("a").sub))
    ignore_case = rules.INJECTION_RULES[2][1]
    assert ignore_case.flags & re.IGNORECASE


def test_every_lazy_pattern_compiles():
    # An invalid pattern must fail here, in CI, and not on the first call that reaches it.
    from zn_gate import rules

    seen, todo, found = set(), list(vars(rules).values()), 0
    while todo:
        value = todo.pop()
        if id(value) in seen:
            continue
        seen.add(id(value))
        if isinstance(value, rules._LazyPattern):
            value.flags  # noqa: B018  (compiles the pattern)
            found += 1
        elif isinstance(value, (list, tuple, set, frozenset)):
            todo.extend(value)
        elif isinstance(value, dict):
            todo.extend(value.values())
    assert found >= 150


def test_lazy_search_delegates_to_the_compiled_pattern_with_and_without_the_prefilter():
    import re

    from zn_gate import rules

    pattern = r"secret[0-9]{3}"
    lazy = rules._LazyPattern(pattern, re.IGNORECASE)
    real = re.compile(pattern, re.IGNORECASE)
    big = rules._PREFILTER_MIN_CHARS
    texts = [
        "x SECRET123 y",  # small, match
        "nothing here",  # small, no match
        "a" * big + " Secret999",  # large, match
        "a" * (big + 5),  # large, no needle: rejected by the prefilter
        "a" * big + " secret",  # large, needle but no match: the regex decides
    ]
    for text in texts:
        got, want = lazy.search(text), real.search(text)
        assert (got is None) == (want is None)
        if want is not None:
            assert got.span() == want.span()
    # With a start position the prefilter is skipped and the compiled search is used.
    assert lazy.search(texts[2], big).span() == real.search(texts[2], big).span()


def test_folded_cache_does_not_keep_the_input_after_evaluate():
    from zn_gate import rules

    text = "plain words " * 2000 + " ignore previous instructions"
    assert len(text) >= rules._PREFILTER_MIN_CHARS
    rules.evaluate(text)
    rules._evaluate_uncached(text)
    assert rules._folded_cache == ("", "")
    assert rules._folded_cache[0] is not text
