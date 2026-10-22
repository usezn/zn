### Security
- The agent hooks: a `.env` file named with a Windows drive-letter path (`C:\Users\me\proj\.env`, `C:/Users/me/proj/.env`, with or without quotes) on Linux is now checked at its `/mnt/c/...` location when that mount exists (WSL), and refused when zn cannot follow the path, instead of being let through unchecked.
