### Fixed
- A JWT or an Azure storage account key wrapped across many short lines was left readable by both scrubbers. They now
  redact it whole, the same way in Node.js and Python.
