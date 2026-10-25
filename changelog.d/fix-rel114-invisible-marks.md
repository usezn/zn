### Security
- The rules now ignore the left-to-right, right-to-left and Arabic letter marks, the Mongolian vowel separator and the Hangul filler characters when they match text, so they can no longer be used to split a trigger phrase (for example `ig<mark>nore previous instructions`). The mostly-invisible output check counts them too. Normal Arabic and Hebrew text is not blocked.
