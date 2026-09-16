package main

import (
	"fmt"
	"log"

	"github.com/nbd-wtf/go-nostr"
)

func main() {
	privateKey := nostr.GeneratePrivateKey()
	publicKey, err := nostr.GetPublicKey(privateKey)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("RELAY_PRIVKEY=%s\nVITE_RELAY_PUBKEY=%s\n", privateKey, publicKey)
}
