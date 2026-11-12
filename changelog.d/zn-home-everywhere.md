### Fixed
- ZN_HOME now moves all of zn state together. The evidence ledger (npm and Python), the hook settings in config.json and the secret request list used to stay in ~/.zn when ZN_HOME was set, while stats, pins, the vault and the cloud key followed ZN_HOME. With the variable unset nothing changes.
  If you already set `ZN_HOME`, `zn-gate evidence` starts empty after the update and the hooks stop reading the hook
  settings you kept in `~/.zn/config.json`. To keep them, move `evidence.jsonl` and `requests.jsonl` from `~/.zn` to
  your `ZN_HOME` folder and copy the `hooks` part of `~/.zn/config.json` into the `config.json` there.
