### Security
- OpenCode: added tests and documentation for the checks on the tools that send data out. `webfetch` is checked like Claude
  Code's WebFetch (a secret placeholder or a secret value in the URL is blocked; personal data follows the egress
  setting), and `websearch` and `codesearch` on their query. `task` and `question` make no network request and are not
  checked as outbound; the OpenCode guide now says so and why.
