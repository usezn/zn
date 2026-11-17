### Security
- The experimental gateway no longer lets a score that is not a number (NaN or infinity) from the neural model slip past a threshold check. Such a score now counts as a block, a model head with non-finite values is refused at load, and a model whose probe score is not finite is not used.
