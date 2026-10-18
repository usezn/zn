### Security
- The encryption of the audit log now takes each 12-byte nonce directly from the operating system's secure random generator. Before, it was cut from a random UUID, which fixes a few of its bits and leaves slightly less randomness than a full nonce. Records written before this change stay readable.
