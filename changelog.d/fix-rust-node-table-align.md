### Fixed
- The Rust gateway now recognises the same override wording and the same card and SSN shapes as the Node.js hook: the override word lists match (more nouns such as prompts, commands and requests, and your/my/these/those in every form), card numbers may mix spaces and dashes, and an SSN needs a 4-digit serial.
- The Rust gateway now flags "forget everything", "forget all" and "forget your ..." the same way as the Node.js hook, with or without punctuation after it, and no longer blocks benign phrases such as "forget the previous requests".
