### Fixed
- `zn start` now answers on its management port on a machine with one CPU (a 1-vCPU VM or container). The policy watcher read its events with a blocking call inside the async runtime, which held the only worker thread, so the management API accepted connections but never answered a request. The watcher now waits on an async channel.
