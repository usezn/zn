### Fixed
- The SIEM export buffer no longer rescans every buffered event on each new event while the endpoint is down, so an audit burst cannot use up CPU; an event larger than the buffer's byte cap is dropped with a warning that reports the count but never its content.
