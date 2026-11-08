"""Premise checks for docker commands in the Python check_command.

Today docker compose up is allowed (it is in the benign corpus) and docker run --privileged is allowed too: no
destructive rule covers docker. The blocking case is strict xfail so it turns into a failure the day a rule lands.
"""

import pytest

from zn_gate.destructive import check_command


def test_docker_compose_up_is_allowed() -> None:
    assert check_command("docker compose up -d").verdict == "allow"


def test_docker_run_without_privileged_is_allowed() -> None:
    assert check_command("docker run --rm alpine echo hi").verdict == "allow"


@pytest.mark.xfail(
    strict=True,
    reason="premise false: docker run --privileged is allowed today; destructive.py has no docker rule",
)
def test_docker_run_privileged_is_blocked() -> None:
    assert check_command("docker run --privileged alpine sh").verdict == "block"
