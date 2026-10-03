// Exercise the SDK's shared-config parser as well as credential_process.
// Instantiating the process provider directly misses INI quote handling.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load config:", err)
		os.Exit(1)
	}
	credentials, err := cfg.Credentials.Retrieve(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "retrieve credentials:", err)
		os.Exit(1)
	}
	if !credentials.CanExpire {
		fmt.Fprintln(os.Stderr, "expected expiring credentials")
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		AccessKeyId     string
		SecretAccessKey string
		SessionToken    string
		Expiration      time.Time
	}{
		AccessKeyId:     credentials.AccessKeyID,
		SecretAccessKey: credentials.SecretAccessKey,
		SessionToken:    credentials.SessionToken,
		Expiration:      credentials.Expires,
	}); err != nil {
		fmt.Fprintln(os.Stderr, "encode credentials:", err)
		os.Exit(1)
	}
}
