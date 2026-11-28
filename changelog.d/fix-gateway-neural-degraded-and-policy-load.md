### Security
- The Rust gateway in `src/` (not part of `zn-gate` on npm or PyPI, so no published version is affected) no longer starts
  with no policy when policy files exist in its folder and none of them loads, even when no signing key or allowed hashes
  are set: it stops with an error that names each file. Before, it only logged a warning and allowed every call.
- `zn::engine::neural::evaluate`, the library function of that gateway, is deprecated and now blocks when the enabled fusion
  check cannot run, instead of dropping that signal and returning an allow from the rules alone. `evaluate_checked` returns
  the reason.
