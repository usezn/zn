### Changed

- When a hook blocks an action because zn could not check it (for example, text that is not valid Unicode or an input nested too deeply), the evidence log now gets one record for it, with the rule `hook-fail-closed` and the error code, and no content from the action. `zn why` can then explain it. `zn-gate stats` still does not count these as blocks. An event that cannot be read at all (not JSON, or empty) still leaves no record, because it names no tool.
