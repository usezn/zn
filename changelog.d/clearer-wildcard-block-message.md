### Changed
- When zn stops a command because a wildcard such as `ls *` or `cat *` would also match a `.env` file (or is too broad to check), the message now says that about the pattern and tells you to name the files you need, instead of saying that `*` "holds secrets". The troubleshooting page explains it.
