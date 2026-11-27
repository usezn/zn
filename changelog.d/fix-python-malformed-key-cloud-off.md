### Changed
- The Python client now treats an API key with the wrong shape (blank, too short, or a placeholder a launcher did not expand) as no key,
  as the Node.js client does: `is_cloud_enabled()` returns false, `analyze()` stays local without a cloud error, and `status` says the key is unused.
