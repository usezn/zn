### Fixed
- The gateway's model hot-swap no longer panics on every later model lookup or stats call after one thread panics while holding one of its locks. The locks now recover from poisoning, and the old model is released after the lock is dropped.
