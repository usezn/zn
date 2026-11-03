### Fixed
- ZN_HOME now moves all of zn state together. The evidence ledger (npm and Python), the hook settings in config.json and the secret request list used to stay in ~/.zn when ZN_HOME was set, while stats, pins, the vault and the cloud key followed ZN_HOME. With the variable unset nothing changes.
