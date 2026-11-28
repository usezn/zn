### Fixed
- The Node.js package redacts a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) with a body of 41 to 255
  characters, as the Python package already did. Before, only a body of 36 to 40 characters was read and a longer
  token stayed fully readable. A fine-grained token longer than 82 characters is redacted whole as well.
