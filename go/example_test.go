package zn_test

import (
	"context"
	"fmt"
	"os"

	zn "github.com/usezn/zn/go"
)

// Check a tool result before the model reads it.
func ExampleClient_Analyze() {
	client := zn.NewClient(os.Getenv("ZN_API_KEY"))

	toolResult := "page text fetched by a tool"
	res, err := client.Analyze(context.Background(), toolResult)
	if err != nil {
		// Fail closed for high-impact tools: do not pass the text on.
		fmt.Println("check failed:", err)
		return
	}
	if res.Blocked() {
		fmt.Println("blocked:", res.Rule)
		return
	}
	fmt.Println("allowed")
}
