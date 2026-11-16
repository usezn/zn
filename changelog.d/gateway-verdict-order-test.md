### Changed

- The experimental Rust gateway (not distributed): one test now pins the order in which it applies its checks to a tool call (invalid request, skipped server, image checks, banned agent, cache, fixed rules, loop breaker, consensus, neural check).
