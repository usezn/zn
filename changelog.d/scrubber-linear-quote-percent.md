### Fixed

- Checking a very long text with many shell quote pairs and percent escapes for secrets no longer slows down more than the text grows (a 3.6 MB text took about 10 seconds).
