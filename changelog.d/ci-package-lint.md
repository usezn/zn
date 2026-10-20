### Changed
- The npm package now declares "type": "commonjs" in its package.json, which is what Node.js already assumed. A new check lints both published packages (the npm tarball with publint, the Python wheel with check-wheel-contents) on every pull request.
