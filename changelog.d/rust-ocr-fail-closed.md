### Security
- With image text scanning (`visual_pii_redaction`) on, a request that carries an image is now refused when the text check cannot run (tesseract missing, timed out or failed), instead of being allowed as clean. In production the gateway refuses to start when the feature is on and tesseract is not installed; other environments log a warning. With the feature off, nothing changes.
