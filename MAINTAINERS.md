# Maintainers

| Name | GitHub | Role |
| --- | --- | --- |
| John Silver | [@tljohnsilver](https://github.com/tljohnsilver) | Lead maintainer: reviews and merges, releases, security response |

Security reports: [security@usezn.com](mailto:security@usezn.com) or GitHub private
vulnerability reporting (see [SECURITY.md](SECURITY.md)).

How maintainers work and how new ones are added: [GOVERNANCE.md](GOVERNANCE.md).

## Triaging a new issue

Aim to answer each new issue in one pass: read it, try to reproduce it once, then label it, reply and decide what happens next.

1. **Check the type.** A question or an idea belongs in [GitHub Discussions](https://github.com/usezn/zn/discussions). Reply with that link and close the issue.
2. **Stop on security reports.** If the issue describes a vulnerability, do not discuss the details in public. Reply that the report must go through the private route in [SECURITY.md](SECURITY.md) (GitHub private vulnerability reporting or [security@usezn.com](mailto:security@usezn.com)), then close the issue without repeating the details. Never ask for exploit details in a public issue.
3. **Reproduce.** Take the zn-gate version, agent and operating system from the report template. Install that version (for example `npx -y zn-gate@<version> --version`) and run the commands from the report. Note the result in one line: reproduced, not reproduced, or needs information.
4. **Label.** Use the labels the issue templates apply: `bug` for a problem with the documented behavior, and `enhancement` for a feature or a new agent. Apply only labels that exist in the repository; if one you need is missing, ask a maintainer in the issue instead of creating one.
5. **Set the severity in your reply.** For a bug, use one of these levels:
   - **High:** a documented command fails for most users, or the gate allows or blocks something it should not, and there is no workaround.
   - **Medium:** it fails only in some setups, or it has a workaround.
   - **Low:** cosmetic issues and documentation errors.
6. **Link duplicates.** Search open and closed issues for the error text or the command. If the same problem is already tracked, reply with a link to the original and close the new issue. If the original is closed but the problem still happens on the latest version, reopen the original and say so.
7. **Ask for what is missing.** If the version, agent, operating system or steps are missing, reply with the exact list you need and leave the issue open until the reporter answers. When there is no answer for a long time, close it with a note that it can be reopened with the missing details.
8. **Reply.** Thank the reporter in one sentence, say what you found (reproduced, likely cause, or next step) and say what happens next. Write in plain English. Do not promise a release date: releases follow the weekly schedule in [GOVERNANCE.md](GOVERNANCE.md#release-schedule).
9. **Close with a reason.** Use one of: fixed in a named version, duplicate of a linked issue, works as documented (link the page), or moved to Discussions.
