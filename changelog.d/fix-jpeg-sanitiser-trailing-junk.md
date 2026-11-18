### Fixed
- The image guard now refuses a JPEG that has bytes that are not a marker between its header segments, instead of copying those bytes through after removing a metadata segment.
