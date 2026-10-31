### Security
- The `rc_download` rule (off by default) now also covers downloads that are saved into or installed as a scheduled or login task: cron files and `crontab` fed from a download, systemd units, launchd plists, desktop autostart entries and login profiles, in addition to shell startup files. Listing, editing or enabling files that were not downloaded in the same command is unchanged.
