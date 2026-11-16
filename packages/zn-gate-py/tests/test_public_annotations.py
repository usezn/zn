"""Public API shape: docstrings and type annotations on every exported name."""
import inspect

import pytest

import zn_gate

# Exported names that are plain data values (str constants); a docstring
# first line would only be the one of the built-in type.
DATA_CONSTANTS = {
    "GENESIS_HASH": "string constant, no own docstring",
    "RULES_VERSION": "string constant, no own docstring",
    "__version__": "string constant, no own docstring",
}

# Exported names with no docstring today.
NO_DOCSTRING = {
    "normalize_input": "documented only by comments today",
    "resolve_endpoint": "documented only by comments today",
}

# Exported functions with missing annotations today: name -> reason.
# Empty today: every exported function is fully annotated.
UNANNOTATED = {}


def _functions():
    return [n for n in zn_gate.__all__ if inspect.isfunction(getattr(zn_gate, n))]


def _missing(name):
    sig = inspect.signature(getattr(zn_gate, name))
    missing = [p for p, v in sig.parameters.items() if v.annotation is inspect.Parameter.empty]
    if sig.return_annotation is inspect.Signature.empty:
        missing.append("return")
    return missing


def test_all_names_exist():
    for name in zn_gate.__all__:
        assert hasattr(zn_gate, name), name


@pytest.mark.parametrize("name", [n for n in zn_gate.__all__ if n not in DATA_CONSTANTS])
def test_docstring_first_line(name):
    doc = inspect.getdoc(getattr(zn_gate, name))
    if name in NO_DOCSTRING:
        assert not doc, f"{name} now has a docstring; remove it from NO_DOCSTRING"
        return
    assert doc and doc.strip().splitlines()[0].strip(), name


@pytest.mark.parametrize("name", _functions())
def test_function_annotations(name):
    missing = _missing(name)
    if name in UNANNOTATED:
        assert missing, f"{name} is fully annotated now; remove it from UNANNOTATED"
        return
    assert not missing, f"{name}: missing annotations for {missing}"


def test_exception_lists_only_name_exports():
    for table in (DATA_CONSTANTS, NO_DOCSTRING, UNANNOTATED):
        for name in table:
            assert name in zn_gate.__all__
