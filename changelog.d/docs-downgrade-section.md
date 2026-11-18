### Changed

- The upgrade guide has a "Going back to an earlier version" section: the pinned npm and pip commands, when to run `zn hooks install <agent>` again, what happens to your vault, evidence log and config, and how to check with `zn-gate check`.
- After an install that leaves the hook launchers written for another zn-gate version, the install prints one line saying to run `zn hooks install <agent>` again for each agent.
