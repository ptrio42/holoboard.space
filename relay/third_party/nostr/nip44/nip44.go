package nip44

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"math"

	"fiatjaf.com/nostr"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"golang.org/x/crypto/chacha20"
	"golang.org/x/crypto/hkdf"
)

const version byte = 2

var zeroes = [32]byte{}

type encryptOptions struct {
	err   error
	nonce [32]byte
}

func WithCustomNonce(nonce []byte) func(opts *encryptOptions) {
	return func(opts *encryptOptions) {
		if len(nonce) != 32 {
			opts.err = fmt.Errorf("invalid custom nonce, must be 32 bytes, got %d", len(nonce))
		}
		copy(opts.nonce[:], nonce)
	}
}

func Encrypt(plaintext string, conversationKey [32]byte, applyOptions ...func(opts *encryptOptions)) (string, error) {
	opts := encryptOptions{}
	for _, apply := range applyOptions {
		apply(&opts)
	}

	if opts.err != nil {
		return "", opts.err
	}

	nonce := opts.nonce
	if nonce == zeroes {
		if _, err := rand.Read(nonce[:]); err != nil {
			return "", err
		}
	}

	cc20key, cc20nonce, hmacKey, err := messageKeys(conversationKey, nonce)
	if err != nil {
		return "", err
	}

	plain := []byte(plaintext)
	size := len(plain)
	if size == 0 {
		return "", fmt.Errorf("plaintext can't be empty")
	}

	padding := calcPadding(size)
	var padded []byte

	if size < (1 << 16) {
		padded = make([]byte, 2+padding)
		binary.BigEndian.PutUint16(padded[0:2], uint16(size))
		copy(padded[2:], plain)
	} else {
		padded = make([]byte, 6+padding)
		binary.BigEndian.PutUint32(padded[2:6], uint32(size))
		copy(padded[6:], plain)
	}

	ciphertext, err := chacha(cc20key, cc20nonce, []byte(padded))
	if err != nil {
		return "", err
	}

	mac, err := sha256Hmac(hmacKey, ciphertext, nonce)
	if err != nil {
		return "", err
	}

	concat := make([]byte, 1+32+len(ciphertext)+32)
	concat[0] = version
	copy(concat[1:], nonce[:])
	copy(concat[1+32:], ciphertext)
	copy(concat[1+32+len(ciphertext):], mac)

	return base64.StdEncoding.EncodeToString(concat), nil
}

func Decrypt(b64ciphertextWrapped string, conversationKey [32]byte) (string, error) {
	cLen := len(b64ciphertextWrapped)
	if cLen < 132 {
		return "", fmt.Errorf("invalid payload length: %d", cLen)
	}
	if b64ciphertextWrapped[0:1] == "#" {
		return "", fmt.Errorf("unknown version")
	}

	decoded, err := base64.StdEncoding.DecodeString(b64ciphertextWrapped)
	if err != nil {
		return "", fmt.Errorf("invalid base64: %w", err)
	}

	if decoded[0] != version {
		return "", fmt.Errorf("unknown version %d", decoded[0])
	}

	dLen := len(decoded)
	if dLen < 99 {
		return "", fmt.Errorf("invalid data length: %d", dLen)
	}

	var nonce [32]byte
	copy(nonce[:], decoded[1:33])
	ciphertext := decoded[33 : dLen-32]
	givenMac := decoded[dLen-32:]
	cc20key, cc20nonce, hmacKey, err := messageKeys(conversationKey, nonce)
	if err != nil {
		return "", err
	}

	expectedMac, err := sha256Hmac(hmacKey, ciphertext, nonce)
	if err != nil {
		return "", err
	}

	if !bytes.Equal(givenMac, expectedMac) {
		return "", fmt.Errorf("invalid hmac")
	}

	padded, err := chacha(cc20key, cc20nonce, ciphertext)
	if err != nil {
		return "", err
	}

	unpaddedLen := int(binary.BigEndian.Uint16(padded[0:2]))
	offset := 2
	if unpaddedLen == 0 {
		unpaddedLen = int(binary.BigEndian.Uint32(padded[2:6]))
		offset = 6
	}

	if unpaddedLen < 1 || len(padded) != offset+calcPadding(unpaddedLen) {
		return "", fmt.Errorf("invalid padding")
	}

	unpadded := padded[offset : offset+unpaddedLen]
	if len(unpadded) == 0 || len(unpadded) != unpaddedLen {
		return "", fmt.Errorf("invalid padding")
	}

	return string(unpadded), nil
}

var maxThreshold, _ = nostr.HexDecodeString("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")

func GenerateConversationKey(pub nostr.PubKey, sk nostr.SecretKey) ([32]byte, error) {
	var ck [32]byte

	if bytes.Compare(sk[:], maxThreshold) != -1 || sk == [32]byte{} {
		return ck, fmt.Errorf("invalid private key: x coordinate %x is not on the secp256k1 curve", sk[:])
	}

	shared, err := computeSharedSecret(pub, sk)
	if err != nil {
		return ck, err
	}

	buf := hkdf.Extract(sha256.New, shared[:], []byte("nip44-v2"))
	copy(ck[:], buf)

	return ck, nil
}

func chacha(key []byte, nonce []byte, message []byte) ([]byte, error) {
	cipher, err := chacha20.NewUnauthenticatedCipher(key, nonce)
	if err != nil {
		return nil, err
	}

	dst := make([]byte, len(message))
	cipher.XORKeyStream(dst, message)
	return dst, nil
}

func sha256Hmac(key []byte, ciphertext []byte, nonce [32]byte) ([]byte, error) {
	h := hmac.New(sha256.New, key)
	h.Write(nonce[:])
	h.Write(ciphertext)
	return h.Sum(nil), nil
}

func messageKeys(conversationKey [32]byte, nonce [32]byte) ([]byte, []byte, []byte, error) {
	r := hkdf.Expand(sha256.New, conversationKey[:], nonce[:])

	cc20key := make([]byte, 32)
	if _, err := io.ReadFull(r, cc20key); err != nil {
		return nil, nil, nil, err
	}
	cc20nonce := make([]byte, 12)
	if _, err := io.ReadFull(r, cc20nonce); err != nil {
		return nil, nil, nil, err
	}

	hmacKey := make([]byte, 32)
	if _, err := io.ReadFull(r, hmacKey); err != nil {
		return nil, nil, nil, err
	}

	return cc20key, cc20nonce, hmacKey, nil
}

func calcPadding(sLen int) int {
	if sLen <= 32 {
		return 32
	}
	nextPower := 1 << int(math.Floor(math.Log2(float64(sLen-1)))+1)
	chunk := int(math.Max(32, float64(nextPower/8)))
	return chunk * int(math.Floor(float64((sLen-1)/chunk))+1)
}

// code adapted from nip04.ComputeSharedSecret()
func computeSharedSecret(pub nostr.PubKey, sk [32]byte) (sharedSecret [32]byte, err error) {
	privKey, _ := btcec.PrivKeyFromBytes(sk[:])

	pubKey, err := btcec.ParsePubKey(append([]byte{2}, pub[:]...))
	if err != nil {
		return sharedSecret, fmt.Errorf("error parsing receiver public key '%s': %w",
			"02"+nostr.HexEncodeToString(pub[:]), err)
	}

	var point, result secp256k1.JacobianPoint
	pubKey.AsJacobian(&point)
	secp256k1.ScalarMultNonConst(&privKey.Key, &point, &result)
	result.ToAffine()

	result.X.PutBytesUnchecked(sharedSecret[:])
	return sharedSecret, nil
}
