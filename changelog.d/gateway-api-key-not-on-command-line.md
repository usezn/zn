### Security
- Experimental Rust gateway (not distributed): the Rust gateway no longer takes the management API key on the command line by default: `--api-key` is refused with a message that names the replacements, `ZN_API_KEY` or the new `--api-key-file <path>` (a file only its owner can access). `--allow-insecure-api-key-flag` keeps the old behaviour with a warning.
