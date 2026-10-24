### Added
- `zn hooks install zcode` warns when the zn-gate ZCode plugin is also installed and on (ZCode would run every check twice), and `zn-gate check` reads the plugin state: a plugin that is turned off while nothing else of zn runs is reported as not protected, and both at once as a note.
- The plugin build can produce a ZCode plugin (`build-plugin-repo.js --target zcode`) that keeps protecting when ZCode's own hooks switch is off; its install steps are published with the plugin repository.
