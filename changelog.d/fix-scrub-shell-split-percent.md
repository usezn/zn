### Fixed
- The scrubber now redacts a secret split by shell quoting (`AKIA""rest`, `'AKIA''rest'`, `key='part''part'`) and a secret written with percent-encoding (`%41KIA...`, `api_key=%66ake...`, `api_key%3Dvalue`). Detection also runs on a decoded view of the text and the whole original word or encoded value is replaced. Ordinary quoted strings and `%20` in URLs are left as they are.
