"""Public API surface: __all__ must agree with what the package README documents.

The README has no API table, so the rule compares __all__ with the names the
README documents:

- A name is documented when it appears as a whole identifier inside an inline
  code span or a fenced code block of packages/zn-gate-py/README.md. Prose
  mentions do not count.
- Dunder names such as __version__ are package metadata, not API, and are not
  checked.

Three checks, for zn_gate and zn_gate.integrations:

- test_documented_names_are_exported: a README code example that uses a name
  the package defines as an object (not a module) must find it in __all__.
- test_all_names_are_documented: every __all__ name must be documented in the
  README. Names not yet documented are listed in KNOWN_UNDOCUMENTED as strict
  xfail. When the README documents one of them, its xfail turns into a failure:
  remove it from the list.
- test_no_accidental_exports: a top-level public name that is neither in
  __all__ nor a zn_gate submodule (for example a typing or stdlib name that
  leaked in through an import) is an accidental export. Names that leaked
  before are listed in LEAKED_NAMES as regression cases: each must stay out.
"""

import os
import re
import types

import pytest

import zn_gate
import zn_gate.integrations as integrations

README = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "README.md")
FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.S)
SPAN_RE = re.compile(r"`([^`\n]+)`")
IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _documented_names():
    with open(README, encoding="utf-8") as fh:
        text = fh.read()
    chunks = FENCE_RE.findall(text) + SPAN_RE.findall(FENCE_RE.sub("", text))
    names = set()
    for chunk in chunks:
        names.update(IDENT_RE.findall(chunk))
    return names


DOCUMENTED = _documented_names()

MODULES = [(zn_gate, "zn_gate"), (integrations, "zn_gate.integrations")]

KNOWN_UNDOCUMENTED = {
    "zn_gate": {
        "Assessment",
        "GENESIS_HASH",
        "RULES_VERSION",
        "SanitizedToolResult",
        "export_evidence_ledger",
        "get_evidence_stats",
        "is_cloud_enabled",
        "normalize_input",
        "resolve_endpoint",
    },
    "zn_gate.integrations": {
        "promptfoo_provider",
    },
}

LEAKED_NAMES = {
    "zn_gate": {
        "Any",
        "Dict",
        "List",
        "TYPE_CHECKING",
        "annotations",
        "importlib",
        "sys",
        "types",
    },
    "zn_gate.integrations": {
        "Any",
        "Dict",
        "List",
        "Tuple",
        "TYPE_CHECKING",
        "annotations",
        "importlib",
    },
}

UNDOC_REASON = "exported in __all__ but not documented in the package README"
ACCIDENT_REASON = "typing, stdlib or __future__ name leaked into the public namespace"


def _public_all(module):
    return [n for n in module.__all__ if not n.startswith("__")]


def _accidental(module):
    prefix = module.__name__ + "."
    found = []
    for name in dir(module):
        if name.startswith("_") or name in module.__all__:
            continue
        obj = getattr(module, name)
        if isinstance(obj, types.ModuleType) and obj.__name__.startswith(prefix):
            continue  # zn_gate submodules are importable on purpose
        found.append(name)
    return found


def _params(cases, known):
    params = []
    for module, label, name in cases:
        marks = []
        if name in known.get(label, ()):
            marks.append(pytest.mark.xfail(strict=True, reason=UNDOC_REASON if known is KNOWN_UNDOCUMENTED else ACCIDENT_REASON))
        params.append(pytest.param(module, name, id="%s.%s" % (label, name), marks=marks))
    return params


@pytest.mark.parametrize("module,label", MODULES, ids=[label for _, label in MODULES])
def test_documented_names_are_exported(module, label):
    missing = []
    for name in sorted(DOCUMENTED):
        if name.startswith("__"):
            continue
        obj = getattr(module, name, None)
        if obj is None or isinstance(obj, types.ModuleType):
            continue
        if name not in module.__all__:
            missing.append(name)
    assert missing == [], "README uses names that %s does not export: %s" % (label, missing)


_UNDOC_CASES = [(module, label, name) for module, label in MODULES for name in _public_all(module)]


@pytest.mark.parametrize("module,name", _params(_UNDOC_CASES, KNOWN_UNDOCUMENTED))
def test_all_names_are_documented(module, name):
    assert name in DOCUMENTED, "%s is in __all__ but the README does not document it" % name


_ACCIDENT_CASES = []
for _module, _label in MODULES:
    _names = set(_accidental(_module)) | LEAKED_NAMES[_label]
    _ACCIDENT_CASES.extend((_module, _label, n) for n in sorted(_names))


@pytest.mark.parametrize("module,name", _params(_ACCIDENT_CASES, {}))
def test_no_accidental_exports(module, name):
    assert name not in _accidental(module), "%s exposes %s without __all__" % (module.__name__, name)
