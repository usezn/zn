### Fixed
- The gateway no longer approves an action that was already denied. Signing an action that is no longer pending is now refused, and so is denying an action that was already approved.
- A ban now lasts until it expires. A successful call no longer lifts the ban early, even when the agent's score goes back above zero.
- An approval can be used only once, even when two requests for the same action arrive at the same time.
