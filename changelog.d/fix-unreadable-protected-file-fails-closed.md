### Security
- A key file (`.pem`, `.key`, `.p8`) or a `.env` file that exists but cannot be opened by zn (for example because of its permissions) was treated like a missing file, so a command that reads it was allowed. zn now refuses such a read and says it could not check the file. A file that does not exist, or one that zn can read and finds harmless, is allowed as before.
