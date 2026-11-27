"""A key with no fixed length (OpenAI, Anthropic, PyPI) wrapped across lines: the rest of the key is redacted with it,
whatever it looks like, and text that holds no such key is left as it was. Same cases as
test/scrub_open_ended_tails.test.js in the Node.js package. Every key is fictitious."""
from zn_gate.rules import redact_scan_secrets, redact_secrets

OPENAI = 'sk-proj-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ'
PYPI = 'pypi-AgEIcHlwaS5vcmc' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ0123456789ABCDEF'


def test_last_piece_shorter_than_a_joinable_line_is_redacted_with_the_key():
    for key, mark in ((OPENAI, '[REDACTED_OPENAI_KEY]'), (PYPI, '[REDACTED_PYPI_TOKEN]')):
        for back in (1, 2, 4, 7, 9):
            cut = len(key) - back
            for sep in ('\n', '\r\n', ' \n', '\n  '):
                out, _ = redact_secrets('token:\n' + key[:cut] + sep + key[cut:] + '\nhello world\n')
                assert out == 'token:\n' + mark + '\nhello world\n', (back, sep)


def test_rest_of_a_key_hidden_by_the_next_line_key_is_redacted_too():
    nxt = 'sk-proj-' + 'Zz9yY8xX7wW6vV5uU4tT3sS2rR1qQ0pP9oO8nN7mM6'
    for back in (3, 9, 10, 16, 25):
        cut = len(OPENAI) - back
        out, _ = redact_secrets(OPENAI[:cut] + '\n' + OPENAI[cut:] + '\n' + nxt)
        assert out == '[REDACTED_OPENAI_KEY]\n[REDACTED_OPENAI_KEY]', back


def test_scan_rules_redact_the_rest_of_the_key_as_well():
    out, _ = redact_scan_secrets(OPENAI[:-4] + '\n' + OPENAI[-4:] + '\nhello world\n')
    assert out == '[REDACTED_OPENAI_KEY]\nhello world\n'


def test_line_with_more_text_after_its_first_word_and_a_complete_key_are_left_alone():
    for nxt in ('see the notes below', 'const x = 1;', 'next line, with a comma', '{ "a": 1 }'):
        out, _ = redact_secrets(OPENAI + '\n' + nxt + '\n')
        assert out == '[REDACTED_OPENAI_KEY]\n' + nxt + '\n', nxt


def test_closing_quote_or_bracket_after_the_rest_of_the_key_stays():
    out, _ = redact_secrets('f("' + OPENAI[:-4] + '\n' + OPENAI[-4:] + '")\n')
    assert out == 'f("[REDACTED_OPENAI_KEY]")\n'


def test_text_without_such_a_key_is_left_as_it_was():
    texts = [
        'internationalization_configuration_manager\n_factory_for_services\n',
        'const veryLongFunctionNameThatKeepsGoingAndGoing =\n  anotherVeryLongIdentifierName;\n',
        'sk-learn is a library\nnumpy\n',
        'ask-the-ops-team-about-this-long-name-here\nok\n',
        'abcdefghijklmnopqrstuvwxyz0123456789\nabcdefghijklmnop\n',
        'plain\nnot a detection of this call\n',
    ]
    for t in texts:
        assert redact_secrets(t)[0] == t, t
