"""What the masker leaves readable (placeholders and references) and what it must still mask (values that look
real), and the destructive check's limits: a line over a limit, or in a folder that is lost, stays refused or
protected. Fake values only; nothing is run (the destructive check only reads the text)."""
import pytest

from zn_gate.destructive import check_command
from zn_gate.rules import _is_non_secret_value, _is_placeholder_value, sanitize_tool_result


def masked(text):
    out, _ = sanitize_tool_result(text)
    return out


# ---- not masked: a placeholder or a reference is not a secret ----

@pytest.mark.parametrize(
    "text",
    [
        "API_KEY=your_api_key_here",
        "API_KEY=<your-api-key>",
        "PASSWORD=changeme",
        "SECRET_KEY=xxxxxxxxxxxxxxxx",
        "API_KEY=sk_test_exampleexampleexample",
        "password=${DB_PASSWORD}",
        "password=$DB_PASSWORD",
        "password: %DB_PASS%",
        "token={{ secrets.TOKEN }}",
        "password = config.get_password()",
        "api_key = os.environ['API_KEY']",
        "db: postgres://user:%DB_PASS%@example.com/db",
        "Authorization: Bearer __ZN_TOKEN__",
    ],
)
def test_placeholders_and_references_stay_readable(text):
    assert masked(text) == text


@pytest.mark.parametrize("value", ["your_api_key_here", "changeme", "${TOKEN}"])
def test_placeholder_helpers_agree(value):
    assert _is_placeholder_value(value) is True
    assert _is_non_secret_value(value) is True


# ---- masked: a value that looks real is hidden, in the same places ----

@pytest.mark.parametrize(
    "text, secret",
    [
        ("API_KEY=1f4a9c7e2b8d03a65e7f1c94ab20d8e3", "1f4a9c7e2b8d03a65e7f1c94ab20d8e3"),
        ("API_KEY=Zq8Tn3xV7bK2mLp9Rw4YcH6dJs1Ae5Uf", "Zq8Tn3xV7bK2mLp9Rw4YcH6dJs1Ae5Uf"),
        ("db: postgres://user:Tr0ub4dor3xK9mQ@example.com/db", "Tr0ub4dor3xK9mQ"),
        ("key AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
        (
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLWZha2UtMDEyMzQ1Njc4OQ",
            "c2lnbmF0dXJlLWZha2UtMDEyMzQ1Njc4OQ",
        ),
    ],
)
def test_values_that_look_real_are_masked(text, secret):
    out = masked(text)
    assert secret not in out
    assert "[REDACTED" in out


def test_a_placeholder_and_a_real_looking_value_in_one_text_are_told_apart():
    text = "API_KEY=your_api_key_here\nSECRET_KEY=1f4a9c7e2b8d03a65e7f1c94ab20d8e3\n"
    out = masked(text)
    assert "API_KEY=your_api_key_here" in out
    assert "1f4a9c7e2b8d03a65e7f1c94ab20d8e3" not in out


# ---- destructive check: limits and folders ----

def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


def _either(n):
    return "".join("if t; then V%d=a; else V%d=b; fi; " % (i, i) for i in range(n))


def test_a_command_with_too_many_readings_is_refused_not_guessed():
    assert rule(_either(3) + "echo " + " ".join("$V%d" % i for i in range(3))) == "allow"
    assert rule(_either(4) + "echo " + " ".join("$V%d" % i for i in range(4))) == "too_many_commands"


def test_a_pipeline_with_too_many_reading_combinations_is_refused():
    pre = "if t; then V=a; else V=b; fi; "
    assert rule(pre + " | ".join(["echo $V"] * 3)) == "allow"
    assert rule(pre + " | ".join(["echo $V"] * 4)) == "too_many_commands"


def test_the_refusal_does_not_hide_a_real_hit_later_in_the_pipeline():
    pre = _either(1)
    assert rule(pre + " | ".join(["echo $V"] * 6) + " | rm -rf /") == "rm_root_home"


def test_a_folder_name_over_the_length_limit_is_refused_for_any_command():
    long_dir = "/" + "a" * 5000
    assert rule("cd " + long_dir + " && rm -rf .") == "too_many_commands"
    assert rule("cd " + long_dir + " && ls") == "too_many_commands"


def test_too_many_backtick_commands_after_a_cd_are_refused():
    tail = " ; ".join("echo `echo %d`" % i for i in range(250))
    assert rule("cd /tmp/example && " + tail) == "too_many_commands"
    assert rule("cd ~ && " + tail + "; rm -rf .") == "too_many_commands"


def test_too_many_commands_and_too_long_a_line_are_refused():
    assert rule("; ".join("echo %d" % i for i in range(60000))) == "too_many_commands"
    assert rule("echo " + "a" * (210 * 1024)) == "too_many_commands"


def test_the_refusal_names_the_reason_in_plain_words():
    r = check_command("cd /" + "a" * 5000 + " && ls")
    assert r.verdict == "block"
    assert "more commands than can be checked" in r.reason
    assert "refused rather than guessed at" in r.reason


def test_a_folder_that_depends_on_which_value_a_variable_holds_stays_protected():
    assert rule("if t; then D=~; else D=/tmp; fi; cd $D && rm -rf .") == "rm_root_home"
    assert rule("if t; then D=~; else D=/tmp; fi; cd $D && ls") == "allow"


def test_a_folder_above_home_stays_protected_for_the_rest_of_the_line():
    assert rule("cd ~ && rm -rf ..") == "rm_root_home"
    assert rule("cd ~ && cd .. && rm -rf .") == "rm_root_home"


def test_an_example_project_folder_is_not_protected():
    assert rule("cd /tmp/example && rm -rf .") == "allow"
