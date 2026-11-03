### Security
- The Claude Code plugin repository builder now refuses bundled code that uses `eval`, the `Function` constructor (also through a called or stored `.constructor` or `module.constructor`, or taken out of an object by destructuring), the `vm` and `worker_threads` built-ins, or a `require()` with a name that is not a plain quoted string, so the import check cannot be bypassed that way.
