### Security
- The Python package now hides a person's name and a postal address in the preview of `zn-gate test`, as the Node.js
  scrubber does: values under `name=`, `full_name=` and `address=` keys, `X-User-Name`, `X-Full-Name` and `X-Address`
  headers, a `full_name` label or JSON key, a street key, the CJK labels `姓名`, `氏名` and `성명`, and `ship to`. Both
  packages now skip product and place titles (`name=Wireless Headphones Pro`), short values such as `Windows 11 Pro`,
  and Han place or organisation words, and they find Han names (`name=王小明`).
