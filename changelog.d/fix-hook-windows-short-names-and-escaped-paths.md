### Fixed
- On Windows, the hook now refuses a protected file named by its 8.3 short name (`SSH~1\ID_ED~1` for an SSH key, `AWS~1\CREDEN~1`
  for the AWS credentials, `SERV~1.PEM` for a private key) or written with doubled backslashes
  (`C:\\Users\\u\\.ssh\\id_work`, as a path arrives when it is JSON-escaped twice), the same as the long name.
