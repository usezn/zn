### Security
- The management API's connection limit can no longer be held up by idle keep-alive connections that already got a successful response: at the limit, the oldest idle connection is closed to make room, and a connection that is answering a request is never closed.
