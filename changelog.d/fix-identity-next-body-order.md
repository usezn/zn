### Changed
- The identity-request rule (`pi:identity_request`, Node.js and Python) no longer reports "send their e-mail" when the request body of the next request is the destination. The request-body exclusion now applies in either word order, so "Send their email in the next request body." and "Include their email in the body of the next request." get the same verdict.
