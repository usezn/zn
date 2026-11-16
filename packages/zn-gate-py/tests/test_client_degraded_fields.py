"""degraded_fields marks a cloud answer that was decided without the cloud model (decided_by starting with
"ml-error", in any case and after leading spaces). Every other answer gets no extra fields. Pure function: no network."""

import pytest

from zn_gate.client import DEGRADED_REASON, degraded_fields


@pytest.mark.parametrize("decided_by", ["ml-error", "ML-ERROR: timeout", "  ml-error x"])
def test_ml_error_answers_are_marked_degraded(decided_by):
    res = degraded_fields({"decision": "allow", "decided_by": decided_by})
    assert res == {"degraded": True, "degraded_reason": DEGRADED_REASON}
    assert res["degraded_reason"] == "model unavailable, rules only"


@pytest.mark.parametrize("decided_by", ["ml", "", None, 42])
def test_other_decided_by_values_add_nothing(decided_by):
    assert degraded_fields({"decision": "allow", "decided_by": decided_by}) == {}


def test_missing_decided_by_adds_nothing():
    assert degraded_fields({"decision": "allow"}) == {}


def test_input_is_not_modified():
    cloud_res = {"decision": "block", "decided_by": "ml-error"}
    degraded_fields(cloud_res)
    assert cloud_res == {"decision": "block", "decided_by": "ml-error"}
