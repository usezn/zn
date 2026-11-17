### Fixed
- The Node.js type definitions now declare `checkCommand` and export the `LogEvidenceOptions` type from `zn-gate`, so TypeScript code can import them. A guarded tool made with `guardTool` keeps the return type of the original function unless `onBlock` is `'return'`. The API reference now says that subpath imports need the `.js` extension in an ES module.
