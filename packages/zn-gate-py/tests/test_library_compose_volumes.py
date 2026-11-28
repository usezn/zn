"""A compose file written by a tool call: its volumes: entries are read like docker run -v.
Mirrors packages/zn-gate/test/library_compose_volumes.test.js. Only example paths; nothing is run."""
import pytest

from zn_gate import check_tool_call


def compose(*entries):
    return "services:\n  app:\n    image: img\n    volumes:\n" + "".join("      - " + e + "\n" for e in entries)


LONG_FORM = "services:\n  app:\n    volumes:\n      - type: bind\n        source: ~/.ssh\n        target: /k\n"


def verdict(file, content):
    return check_tool_call("Write", {"file_path": file, "content": content}).verdict


@pytest.mark.parametrize(
    "content",
    [
        compose("~/.ssh:/root/.ssh"),
        compose('"~/.aws:/root/.aws:ro"'),
        compose("${HOME}/.ssh:/k"),
        compose("/home/user/.aws/credentials:/c:ro"),
        compose("./.env:/app/.env"),
        LONG_FORM,
    ],
)
def test_compose_with_protected_host_path_is_refused(content):
    assert verdict("/proj/docker-compose.yml", content) == "block"
    assert verdict("/proj/stack.yaml", content) == "block"


@pytest.mark.parametrize(
    "content",
    [
        compose("./data:/data"),
        compose("named:/data", "./src:/src:ro"),
        compose("~/.ssh/known_hosts:/k:ro"),
        "services:\n  app:\n    image: img\n    env_file: ./app.env\n",
    ],
)
def test_compose_with_named_volumes_and_harmless_binds_is_allowed(content):
    assert verdict("/proj/docker-compose.yml", content) == "allow"


@pytest.mark.parametrize(
    "cmd",
    ["docker run --volume ~/.ssh:/k img", "podman run --mount src=~/.aws,dst=/k img", 'nerdctl run -v"$HOME/.ssh":/k img'],
)
def test_container_commands_with_protected_mounts_are_refused(cmd):
    assert check_tool_call("Bash", {"command": cmd}).verdict == "block"


@pytest.mark.parametrize("cmd", ["docker run -v $PWD/data:/data img", "docker run -v named:/d img", "docker run --env-file=.env img"])
def test_container_commands_with_harmless_mounts_are_allowed(cmd):
    assert check_tool_call("Bash", {"command": cmd}).verdict == "allow"
