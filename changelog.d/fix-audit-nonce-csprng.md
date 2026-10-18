### Security
- The encryption of the audit log now draws each 12-byte nonce from a cryptographically secure random generator seeded by the operating system. Before, it was cut from a random UUID, which fixes a few of its bits and leaves slightly less randomness than a full nonce. Records written before this change stay readable.
