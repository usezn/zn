### Fixed
- The ZCode plugin's Windows hook works from a user folder with a space, `&`, parentheses, `^` or `%` in its name, and always runs the scripts of the plugin folder: never a file of the same name in the project, also when `ZCODE_PLUGIN_ROOT` is not set.

### Security
- The ZCode plugin's Windows hook answers in time. ZCode stops waiting for a hook after 30 seconds and then lets the call run, so the hook now blocks the call by itself 26 seconds after it started, counted from the moment ZCode started it, on both the direct Node.js path and the PowerShell one, also when zn-gate is stuck in work that never gives the launcher's timer a chance to run. Before, a slow PowerShell start or a stuck check could run past the timeout and the call ran. The PowerShell path no longer uses commands that Windows PowerShell has to look up in its modules, and its lookup of the program that started it has a time limit: on a machine without the module cache that lookup alone could take most of the 30 seconds.
- When the ZCode plugin's Windows hook finds no usable Node.js, it blocks the call. It no longer takes the Windows command interpreter or another shell that started it for Node.js.
