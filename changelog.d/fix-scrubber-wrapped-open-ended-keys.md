### Security
- A key with no fixed length (OpenAI `sk-...`, Anthropic `sk-ant-...`, PyPI `pypi-...`) that was wrapped across
  lines could leave its last piece readable: when that piece was shorter than ten characters, or when the next
  line held another key, the scrubber redacted the first lines and kept the rest as plain text. The Node.js and
  Python scrubbers now treat a line that is only a token, right after the redacted key, as the rest of that key and
  redact it too. This also redacts a one-word line that follows such a key (for example `EOF`), because it cannot
  be told apart from a short rest of the key; a line with more text after its first word is left as it was. A key
  whose first line is shorter than ten characters is still not joined.
