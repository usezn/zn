"""A fictitious key split in pieces by one of many separators (tabs, no-break spaces, Unicode line separators, line
breaks, quoted string pieces, escaped break sequences, zero-width characters) leaves no readable run of 8 or more of
its characters, and ordinary text with quotes or odd spaces is left as it was. Same cases as
test/scrub_break_classes.test.js in the Node.js package."""
import re

import pytest

from zn_gate.rules import redact_secrets

KEYS = {
    'github': 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    'aws': 'AKIA' + 'Z7Q2M9X4B6C1D8E3',
    'hex': 'dop_v1_' + '0123456789abcdef' * 4,
    'openai': 'sk-proj-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ',
}
SEPARATORS = {
    'tab': '\t',
    'nbsp': '\u00a0',
    'line_separator': '\u2028',
    'paragraph_separator': '\u2029',
    'line_feed': '\n',
    'crlf': '\r\n',
    'space_line_feed': ' \n',
    'indented_line_feed': '\n    ',
    'backslash_line_feed': ' \\\n',
    'double_quotes_plus': '"+"',
    'double_quotes_space': '" "',
    'single_quotes_plus': "' + '",
    'quoted_lines': '"\n"',
    'escaped_n': '\\n',
    'escaped_crlf': '\\r\\n',
    'escaped_t': '\\t',
    'zero_width': '\u200b',
}
WIDTHS = [8, 9, 13, 20, 40]
CONTEXTS = [('', ''), ('token: ', '\nnext line\n'), ('{"k": "', '", "n": 3}')]
STRIP = re.compile('\\\\[nrt]|[\\s"\'+\\\\`\u2028\u2029\u00a0\u200b\u200c\u200d\ufeff]')


def wrap(key, width, sep):
    return sep.join(key[i:i + width] for i in range(0, len(key), width))


def readable_run(secret, out):
    flat = STRIP.sub('', out)
    for i in range(len(secret) - 7):
        if secret[i:i + 8] in flat:
            return secret[i:i + 8]
    return ''


@pytest.mark.parametrize('sep_name', sorted(SEPARATORS))
def test_a_key_split_by_the_separator_leaves_no_readable_part(sep_name):
    sep = SEPARATORS[sep_name]
    for name, key in KEYS.items():
        for width in WIDTHS:
            for pre, post in CONTEXTS:
                text = pre + wrap(key, width, sep) + post
                run = readable_run(key, redact_secrets(text)[0])
                assert run == '', '%s width %d %r: readable %r' % (name, width, pre, run)


def test_text_with_quoted_words_tabs_and_odd_spaces_is_left_as_it_was():
    texts = [
        '"hello world" "foo bar"',
        '{"a": "some words here", "b": "other words here"}',
        "echo 'one two three' 'four five six'",
        'const a = "abcdefghij" + "klmnopqr";',
        'name\tvalue\tother column\tlast',
        'plain\u00a0text with a no-break space\u00a0inside it',
        'line one\\nline two\\nline three',
        'path C:\\temp\\new folder\\table.txt',
        'quoted "abcdefghijkl" and then "mnop"',
    ]
    for t in texts:
        assert redact_secrets(t)[0] == t, repr(t)
