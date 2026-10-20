### Changed
- The Python install instructions (root README and the PyPI page) now include a Windows path that works on a clean machine: `py -m venv`, calling `.venv\Scripts\pip` and `.venv\Scripts\zn-gate` directly (no `Activate.ps1`, so the default execution policy is not a problem), and what to do when `python` or `zn-gate` is not recognized.
