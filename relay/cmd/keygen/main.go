package main

import (
	"fiatjaf.com/nostr"
	"fmt"
)

func main() {
	privateKey := nostr.Generate()
	fmt.Printf("RELAY_PRIVKEY=%s\nVITE_RELAY_PUBKEY=%s\n", privateKey.Hex(), privateKey.Public().Hex())
}
