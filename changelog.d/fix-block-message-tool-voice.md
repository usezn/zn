### Changed
- The message an agent gets when zn blocks a read of a `.env` file or a credentials file is now worded as a plain tool result (what was blocked, why, and what the user can run) instead of an order to the model. A model that took the old wording for an instruction hidden in a file refused to relay it, so the user never learned the fix. The user-facing documentation shows the new text.
