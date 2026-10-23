### Fixed
- The Antigravity hook now answers with a deny, with a reason, when a check has not finished 5 seconds before the hook's timeout or an error escapes, instead of printing nothing (Antigravity blocks the call with an empty reason when a hook prints nothing). Tests run the real hook process through a hung check, an escaped error and unreadable input.
