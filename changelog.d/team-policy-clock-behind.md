### Security
- zn Team: setting a computer's clock back no longer switches off the organization's rules. If the clock is behind the time the cached policy was issued, zn now applies strict mode (only restrictions apply) instead of ignoring the policy. `zn team status` and `zn team sync` now tell you to check the computer's date and time when the clock looks wrong.
