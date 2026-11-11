"""A personal access token under a name that ends in PAT is masked. Fake values only."""
import pytest

from zn_gate import redact_secrets

# 52 characters, mixed case and digits, not a real token.
VALUE = "Zx9kQ2mN8pL4" + "rT6vW1yHc5J0" + "aB3dF7gH9jK2" + "mN4pQ6rS8tU1" + "vW3y"


@pytest.mark.parametrize("text", [
    "AZURE_DEVOPS_EXT_PAT=" + VALUE,
    "export AZURE_DEVOPS_EXT_PAT=" + VALUE,
    'AZURE_DEVOPS_EXT_PAT="' + VALUE + '"',
    "echo start\nAZURE_DEVOPS_EXT_PAT=" + VALUE + "\necho end",
    "GH_PAT=" + VALUE,
    "ENV ADO_PAT " + VALUE,
])
def test_pat_named_value_is_masked(text):
    out, det = redact_secrets(text)
    assert VALUE not in out
    assert det


@pytest.mark.parametrize("text", [
    "PAT=yes",
    "AZURE_DEVOPS_EXT_PAT=short",
    "PATH=/usr/local/bin:/usr/bin:/bin:/opt/tools/bin",
    "COMPAT=" + VALUE,
    "PATTERN=" + VALUE,
    "SPATIAL_INDEX=" + VALUE,
])
def test_names_without_the_pat_word_and_short_values_stay(text):
    out, det = redact_secrets(text)
    assert out == text
    assert det == []
