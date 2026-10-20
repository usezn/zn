### Security
- The gateway's file guard now blocks more credential files (AWS, SSH keys, `.netrc`, Docker, Kubernetes, git, PostgreSQL, Google Cloud and Azure tokens), matches them with `/` or `\` separators in any letter case, and recognizes Windows paths inside JSON arguments.
