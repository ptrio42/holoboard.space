package nip04

import (
	"strings"
	"testing"

	"fiatjaf.com/nostr"
	"github.com/stretchr/testify/require"
)

func TestSharedKeysAreTheSame(t *testing.T) {
	for i := 0; i < 100; i++ {
		sk1 := nostr.Generate()
		sk2 := nostr.Generate()

		pk1 := nostr.GetPublicKey(sk1)
		pk2 := nostr.GetPublicKey(sk2)

		ss1, err := ComputeSharedSecret(pk2, sk1)
		require.NoError(t, err)
		ss2, err := ComputeSharedSecret(pk1, sk2)
		require.NoError(t, err)

		require.Equal(t, ss1, ss2)
	}
}

func TestEncryptionAndDecryption(t *testing.T) {
	sharedSecret := make([]byte, 32)
	message := "hello hello"

	ciphertext, err := Encrypt(message, sharedSecret)
	require.NoError(t, err)

	plaintext, err := Decrypt(ciphertext, sharedSecret)
	require.NoError(t, err)

	require.Equal(t, plaintext, message, "original '%s' and decrypted '%s' messages differ", message, plaintext)
}

func TestEncryptionAndDecryptionWithMultipleLengths(t *testing.T) {
	sharedSecret := make([]byte, 32)

	for i := 0; i < 150; i++ {
		message := strings.Repeat("a", i)

		ciphertext, err := Encrypt(message, sharedSecret)
		require.NoError(t, err)

		plaintext, err := Decrypt(ciphertext, sharedSecret)
		require.NoError(t, err)

		require.Equal(t, plaintext, message, "original '%s' and decrypted '%s' messages differ", message, plaintext)
	}
}

func TestNostrToolsCompatibility(t *testing.T) {
	sk1, _ := nostr.HexDecodeString("92996316beebf94171065a714cbf164d1f56d7ad9b35b329d9fc97535bf25352")
	sk2, _ := nostr.HexDecodeString("591c0c249adfb9346f8d37dfeed65725e2eea1d7a6e99fa503342f367138de84")
	pk2 := nostr.GetPublicKey([32]byte(sk2))
	shared, _ := ComputeSharedSecret(pk2, [32]byte(sk1))
	ciphertext := "A+fRnU4aXS4kbTLfowqAww==?iv=QFYUrl5or/n/qamY79ze0A=="
	plaintext, _ := Decrypt(ciphertext, shared)
	require.Equal(t, "hello", plaintext, "invalid decryption of nostr-tools payload")
}
