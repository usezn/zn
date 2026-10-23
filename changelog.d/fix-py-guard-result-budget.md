### Security
- Python: a tool result holding a plain object with more than 100,000 values (for example JSON read into a custom class with `json.loads(..., object_hook=...)`) had the values past that limit skipped without being checked. Such a result is now blocked (rule `size:items`), as it is for dicts and data models. Arguments passed to `@guard` keep reading application objects best effort.
