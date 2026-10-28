### Fixed
- The evidence log lock is also removed when its token is only partly written or the lock file cannot be closed, and the Python package now removes it too when the token cannot be written (as the Node.js package already did on a full disk). A lock left behind made every later write wait and report that another process was writing.
