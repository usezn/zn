### Fixed
- A wrong system clock can no longer wipe your local stats history. A record written while the clock was far in the future used to delete every older day, and the future day then inflated every 30-day summary. Pruning now skips when the clock is far ahead of the stored data, and days dated in the future are left out of the summaries.
