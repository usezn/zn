'use strict';

// True when a stdout error means the reader has closed the pipe. Linux and macOS report
// EPIPE. On Windows, libuv maps ERROR_BROKEN_PIPE to UV_EOF, so the same situation arrives as EOF.
function isBrokenPipe(err, platform) {
  if (!err) return false;
  if (err.code === 'EPIPE') return true;
  return (platform || process.platform) === 'win32' && err.code === 'EOF';
}

module.exports = { isBrokenPipe };
