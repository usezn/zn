"""Direct tests of the canonical JSON forms and the last-line reader used by the evidence ledger."""
import json

from zn_gate.evidence import _canonical, _canonical_ascii, _read_last_line


def test_canonical_ascii_escapes_non_ascii():
    out = _canonical_ascii({"msg": "café 中"})
    assert out == '{"msg":"caf\\u00e9 \\u4e2d"}'
    assert out.isascii()


def test_canonical_ascii_astral_char_is_escaped_as_surrogate_pair():
    out = _canonical_ascii({"msg": "\U0001F600"})
    assert out == '{"msg":"\\ud83d\\ude00"}'
    assert json.loads(out) == {"msg": "\U0001F600"}


def test_canonical_ascii_lone_surrogate_is_escaped():
    out = _canonical_ascii({"msg": "\ud800"})
    assert out == '{"msg":"\\ud800"}'


def test_canonical_ascii_is_compact_and_differs_from_canonical_for_non_ascii():
    record = {"a": 1, "b": "é"}
    assert _canonical_ascii(record) == '{"a":1,"b":"\\u00e9"}'
    assert _canonical(record) == '{"a":1,"b":"é"}'


def test_canonical_ascii_equals_canonical_for_plain_ascii():
    record = {"a": [1, 2], "b": "text"}
    assert _canonical_ascii(record) == _canonical(record)


def test_read_last_line_empty_file(tmp_path):
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b"")
    assert _read_last_line(str(p)) is None


def test_read_last_line_whitespace_only_file(tmp_path):
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b" \n\t\r\n\n")
    assert _read_last_line(str(p)) is None


def test_read_last_line_without_final_newline(tmp_path):
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b'{"n":1}\n{"n":2}')
    assert _read_last_line(str(p)) == b'{"n":2}'


def test_read_last_line_with_final_newline_and_blank_lines(tmp_path):
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b'{"n":1}\n{"n":2}\n\n\n')
    assert _read_last_line(str(p)) == b'{"n":2}'


def test_read_last_line_single_line_no_newline(tmp_path):
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b'{"n":1}')
    assert _read_last_line(str(p)) == b'{"n":1}'


def test_read_last_line_non_ascii_and_surrogate_pair_bytes(tmp_path):
    line = json.dumps({"msg": "café \U0001F600"}, ensure_ascii=False)
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b'{"n":1}\n' + line.encode("utf-8") + b"\n")
    assert _read_last_line(str(p)).decode("utf-8") == line


def test_read_last_line_very_long_line_spans_several_windows(tmp_path):
    long_line = b'{"pad":"' + b"x" * 300_000 + b'"}'
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b'{"n":1}\n' + long_line + b"\n")
    assert _read_last_line(str(p)) == long_line


def test_read_last_line_very_long_line_without_newline_before_it(tmp_path):
    long_line = b"y" * 200_000
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(long_line)
    assert _read_last_line(str(p)) == long_line


def test_read_last_line_multibyte_char_across_window_boundary(tmp_path):
    long_line = ("é" * 100_000).encode("utf-8")
    p = tmp_path / "ledger.jsonl"
    p.write_bytes(b"first\n" + long_line)
    assert _read_last_line(str(p)) == long_line
