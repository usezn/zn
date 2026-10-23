### Security
- Python `@guard` now scans arguments that were fixed with `functools.partial` before the decorator was applied, including nested partials.
- Python `@guard` placed above `@classmethod` or `@staticmethod` no longer raises `TypeError`: the method keeps working when called through the class or an instance, and its arguments are still scanned.
