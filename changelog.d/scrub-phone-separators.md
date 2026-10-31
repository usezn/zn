### Fixed
- The egress check and the scrubber now find international phone numbers written with spaces, dashes or dots, such as `+34 600 123 456` and `+1 202-555-0143`, not only the compact form. Numbers without a leading `+` are still not detected, and the docs now say so.
