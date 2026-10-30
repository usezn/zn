### Security

- zn Team: the hooks no longer trust `~/.zn/team.json` alone for the organization's signing key. When the vault is unlocked, the key it holds is compared with the one in `team.json`; if they differ (for example a replaced `team.json` plus a policy signed by another key), zn uses the policy held in the vault, restores the files, tells you, and writes an audit record. The "your organization changed its policy" line is now remembered in the vault, so editing `~/.zn/team-notice.json` or `org-policy.json` can no longer hide it.
