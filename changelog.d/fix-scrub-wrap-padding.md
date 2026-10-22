### Security
- Secret redaction (npm and Python packages): the last line of a wrapped base64 value that ends in `==` padding is now joined to the rest and redacted with it, instead of being read as a `NAME=` setting and left in the text.
