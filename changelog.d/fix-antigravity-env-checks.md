### Security
- Antigravity: the hook now blocks `write_to_file` and `multi_replace_file_content` on a `.env` file that holds plain-text secrets, as the docs say, and asks before a recursive shell search (`grep -r`, `rg`) over a folder that holds one, like it does for the search tool.
