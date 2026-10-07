package main

import (
	"fmt"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nip04"
	"fiatjaf.com/nostr/nip19"
	"fiatjaf.com/nostr/nip44"
	"github.com/btcsuite/btcd/btcutil/bech32"
)

// Configuration, ledger keys and HTTP APIs retain their hexadecimal encoding.
func generatePrivateKey() string { return nostr.Generate().Hex() }

func publicKeyForSecret(value string) (string, error) {
	if !isHex64(value) {
		return "", fmt.Errorf("invalid private key encoding")
	}
	key, err := nostr.SecretKeyFromHex(value)
	if err != nil {
		return "", err
	}
	return key.Public().Hex(), nil
}

func signEvent(event *nostr.Event, value string) error {
	if !isHex64(value) {
		return fmt.Errorf("invalid private key encoding")
	}
	key, err := nostr.SecretKeyFromHex(value)
	if err != nil {
		return err
	}
	return event.Sign(key)
}

func verifyNostrEvent(event *nostr.Event) (bool, error) {
	return event != nil && event.CheckID() && event.VerifySignature(), nil
}

func eventIDs(values ...string) []nostr.ID {
	ids := make([]nostr.ID, 0, len(values))
	for _, value := range values {
		if id, err := nostr.IDFromHex(value); err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

func publicKeys(values ...string) []nostr.PubKey {
	keys := make([]nostr.PubKey, 0, len(values))
	for _, value := range values {
		if key, err := nostr.PubKeyFromHexCheap(value); err == nil {
			keys = append(keys, key)
		}
	}
	return keys
}

func encodeEventReference(value string, relays []string, author string) (string, error) {
	id, err := nostr.IDFromHex(value)
	if err != nil {
		return "", err
	}
	var key nostr.PubKey
	if author != "" {
		key, err = nostr.PubKeyFromHexCheap(author)
		if err != nil {
			return "", err
		}
	}
	return nip19.EncodeNevent(id, relays, key), nil
}

func encodePublicKey(value string) (string, error) {
	key, err := nostr.PubKeyFromHexCheap(value)
	if err != nil {
		return "", err
	}
	return nip19.EncodeNpub(key), nil
}

func encodeNoteReference(value string) (string, error) {
	id, err := nostr.IDFromHex(value)
	if err != nil {
		return "", err
	}
	data, err := bech32.ConvertBits(id[:], 8, 5, true)
	if err != nil {
		return "", err
	}
	return bech32.Encode("note", data)
}

func computeSharedSecret(pubkey, secret string) ([]byte, error) {
	key, err := nostr.PubKeyFromHexCheap(pubkey)
	if err != nil {
		return nil, err
	}
	if !isHex64(secret) {
		return nil, fmt.Errorf("invalid private key encoding")
	}
	sk, err := nostr.SecretKeyFromHex(secret)
	if err != nil {
		return nil, err
	}
	return nip04.ComputeSharedSecret(key, sk)
}
func conversationKey(pubkey, secret string) ([32]byte, error) {
	key, err := nostr.PubKeyFromHexCheap(pubkey)
	if err != nil {
		return [32]byte{}, err
	}
	if !isHex64(secret) {
		return [32]byte{}, fmt.Errorf("invalid private key encoding")
	}
	sk, err := nostr.SecretKeyFromHex(secret)
	if err != nil {
		return [32]byte{}, err
	}
	return nip44.GenerateConversationKey(key, sk)
}
func referenceAuthor(key nostr.PubKey) string {
	if key == nostr.ZeroPK {
		return ""
	}
	return key.Hex()
}

// collectTags adapts the upstream iterator at callers that need indexing or length.
func collectTags(tags nostr.Tags, name string) []nostr.Tag {
	var result []nostr.Tag
	for tag := range tags.FindAll(name) {
		result = append(result, tag)
	}
	return result
}
