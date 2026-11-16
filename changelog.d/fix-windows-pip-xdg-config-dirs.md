### Fixed

- On Windows, the optional online package check now reads the folders in `XDG_CONFIG_DIRS` correctly when it looks for a private pip registry. The list was split at `:`, which also follows the drive letter, so a private registry configured there was missed.
