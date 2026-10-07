package nip45

import (
	"crypto/sha256"
	"strconv"
	"strings"

	"fiatjaf.com/nostr"
)

// HyperLogLogFilterIsEligible returns true if the filter matches one of the
// explicitly supported NIP-45 common filter cases for HyperLogLog computation.
func HyperLogLogFilterIsEligible(filter nostr.Filter) bool {
	_, _, ok := extractHLLFilterTag(filter)
	return ok
}

// extractHLLFilterTag extracts tag key and value from a filter eligible for
// HyperLogLog. Returns (tagKey, tagValue, true) when the filter matches one
// of the explicitly supported NIP-45 cases.
func extractHLLFilterTag(filter nostr.Filter) (string, string, bool) {
	if filter.IDs != nil || filter.Since != 0 || filter.Until != 0 || filter.Authors != nil ||
		filter.Search != "" {
		return "", "", false
	}

	if len(filter.Tags) != 1 {
		return "", "", false
	}

	// get first (only) tag key and its value
	var tagKey string
	var tagValues []string
	for k, v := range filter.Tags {
		tagKey = k
		tagValues = v
	}

	if len(tagValues) != 1 {
		return "", "", false
	}

	tagValue := tagValues[0]

	// validate filter is one of the common NIP-45 cases
	switch tagKey {
	case "e":
		if len(filter.Kinds) != 1 || (filter.Kinds[0] != 1 && filter.Kinds[0] != 6 && filter.Kinds[0] != 7 && filter.Kinds[0] != 1111) {
			return "", "", false
		}
	case "q":
		if len(filter.Kinds) != 2 {
			return "", "", false
		}
		if !(filter.Kinds[0] == 1 && filter.Kinds[1] == 1111) && !(filter.Kinds[0] == 1111 && filter.Kinds[1] == 1) {
			return "", "", false
		}
	case "E":
		if len(filter.Kinds) != 1 || filter.Kinds[0] != 1111 {
			return "", "", false
		}
	case "p":
		if len(filter.Kinds) != 1 || filter.Kinds[0] != 3 {
			return "", "", false
		}
	default:
		return "", "", false
	}

	return tagKey, tagValue, true
}

// HyperLogLogEventPubkeyOffsetForFilter returns the deterministic pubkey offset that will be used
// when computing hyperloglogs in the context of a specific filter.
//
// It returns -1 when the filter is not eligible for hyperloglog calculation.
func HyperLogLogEventPubkeyOffsetForFilter(filter nostr.Filter) int {
	_, tagValue, ok := extractHLLFilterTag(filter)
	if !ok {
		return -1
	}

	// derive 32-byte hex string from tag value per NIP-45 offset computation
	var hexStr string
	if nostr.IsValid32ByteHex(tagValue) {
		hexStr = tagValue
		goto haveHexStr
	}

	// address format: <kind>:<pubkey>:<d-tag>
	if parts := strings.SplitN(tagValue, ":", 3); len(parts) == 3 && nostr.IsValid32ByteHex(parts[1]) {
		hexStr = parts[1]
		goto haveHexStr
	}

	// fallback
	{
		hash := sha256.Sum256([]byte(tagValue))
		hexStr = nostr.HexEncodeToString(hash[:])
	}

haveHexStr:
	// character at position 32 (0-indexed), parse as hex nibble, add 8 for offset
	p, err := strconv.ParseInt(hexStr[32:33], 16, 64)
	if err != nil {
		return -1
	}
	return int(p + 8)
}
