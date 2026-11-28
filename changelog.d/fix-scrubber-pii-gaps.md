### Security
- The scrubber now hides personal data it missed: a US phone number written `(415) 555-0132` (also `+1 (415) 555-0132`),
  an American Express number written with spaces in groups of 4, 6 and 5, a name under a `full_name` label or JSON key
  (two capitalised words) or under the CJK labels `姓名`, `氏名` and `성명`, and a street address under a `street` key
  or after `ship to`. Phone numbers and cards are hidden by the Node.js and the Python package alike; names and
  addresses are Node.js only for now.
