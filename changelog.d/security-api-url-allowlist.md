### Security

- The cloud check sends the API key only to `https://api.usezn.com`. `ZN_API_URL` or `--url` naming another host, or plain `http://`, is refused before the request is built, and the local rules are used with a one-line message. A gateway on this machine (`localhost`, `127.0.0.1`, `::1`) works only with `ZN_API_ALLOW_LOCALHOST=1`, for development. The Python client no longer follows redirects, which could forward the key to another address. Before, a project that set `ZN_API_URL` in the agent's environment could receive the key given with `ZN_API_KEY`.
