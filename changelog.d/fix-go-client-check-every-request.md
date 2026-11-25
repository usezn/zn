### Security
- The scheme rule is now enforced at the transport for every request the client sends, including after your own `CheckRedirect` rewrites a redirect, and the `Authorization` header is dropped for any host other than the base URL host.
