// Package zn is a small client for the optional zn Cloud API
// (POST https://api.usezn.com/v30/analyze).
//
// It checks text, such as a tool result, a web page or an email, for
// prompt-injection attempts before a model reads it. It uses only the Go
// standard library.
//
//	client := zn.NewClient(os.Getenv("ZN_API_KEY"))
//	res, err := client.Analyze(ctx, toolResult)
//	if err != nil {
//		// Decide whether to fail closed or open; see the README.
//	}
//	if !res.Allowed() {
//		// Block, or an unknown or missing verdict: do not pass the text to the model.
//	}
//
// The API is documented at https://usezn.com/docs/api/.
package zn
