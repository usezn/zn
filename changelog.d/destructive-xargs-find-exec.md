### Security

- The destructive-command check now sees commands run through `xargs` and `find -exec`, `-execdir` and `-ok`, and reads `toybox` as the program it runs. Before, some commands that were blocked in their plain form were not blocked behind them. When the input of `xargs` is not known, the check assumes the worst; a `find` with a test, and ordinary uses such as `find . -name '*.log' -print` or `xargs -n1 echo`, stay allowed.
