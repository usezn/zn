### Fixed
- The Antigravity hook always answers with an explicit allow or deny, with a reason, including when zn fails inside or cannot read the event. Antigravity denies every tool call, with an empty reason, when a hook prints nothing, text that is not JSON, or `{}`.
- `zn hooks install antigravity` starts the installed hook once with a harmless test event and tells you, with the next step, if it does not answer with a valid decision.
- The Antigravity docs and the compatibility page now say what we saw when the hook cannot run (Antigravity blocks the call; a timeout was not tested) and that file searches run through the shell, so zn checks them as commands.
