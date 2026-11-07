### Fixed
- The guided install no longer says "no internet connection" when the npm install only ran too long. It now says the install took longer than the time limit and was stopped, that it may be incomplete, and shows `npm ls -g zn-gate` to check it and the command to run it again. The no-internet message is now plain sentences instead of two colons in a row.
