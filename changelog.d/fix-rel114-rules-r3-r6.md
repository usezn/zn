### Security
- The sensitive-file rule now matches Windows paths and mixed separators, such as `C:\Users\name\.ssh\id_rsa` and `C:/Users/name\.aws/credentials`, in the same places it matches POSIX paths.
- The hidden-element rule now looks at real attributes: the `hidden` attribute, `aria-hidden="true"`, a style that hides the element or gives it no size, or the class `hidden`. A name that only contains the word (`data-hidden`), a style value such as `opacity:0.5` and plain mentions of a tag no longer count.
- The Base64 check treats `openssl` as a decoder only in its decode forms (`openssl base64 -d`, `openssl enc -d -base64`), so encoding and hashing commands that follow an `echo` are no longer decoded and blocked.
- In the Node package, a compatibility character with no folded form (such as U+2072) is now kept in the text that rules match against instead of becoming the word "undefined". The Python package already did this.
