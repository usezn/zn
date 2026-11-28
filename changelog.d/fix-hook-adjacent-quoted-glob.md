### Fixed
- The shell hook no longer refuses a quoted pattern written as two or more adjacent quoted parts (for example `'*''.log'` or `'*'".log"`) as a program argument: the shell joins the parts into one literal word and never expands the `*`, so it is judged like `"*.log"`. Unquoted patterns and patterns mixed with unquoted text are refused as before.
