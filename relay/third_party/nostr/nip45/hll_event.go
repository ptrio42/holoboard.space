package nip45

import (
	"iter"
	"strconv"

	"fiatjaf.com/nostr"
)

func HyperLogLogTargetsForEvent(evt nostr.Event) iter.Seq2[string, int] {
	return func(yield func(string, int) bool) {
		switch evt.Kind {
		case 1:
			// reply count (last #e)
			lastE := evt.Tags.FindLast("e")
			if lastE != nil {
				v := lastE[1]
				if nostr.IsValid32ByteHex(v) {
					p, _ := strconv.ParseInt(v[32:33], 16, 64)
					if !yield(v, int(p+8)) {
						return
					}
				}
			}
			// quote count (#q)
			for qTag := range evt.Tags.FindAll("q") {
				v := qTag[1]
				if nostr.IsValid32ByteHex(v) {
					p, _ := strconv.ParseInt(v[32:33], 16, 64)
					if !yield(v, int(p+8)) {
						return
					}
				}
			}
		case 3:
			// follower counts
			for _, tag := range evt.Tags {
				if len(tag) >= 2 && tag[0] == "p" && nostr.IsValid32ByteHex(tag[1]) {
					p, _ := strconv.ParseInt(tag[1][32:33], 16, 64)
					if !yield(tag[1], int(p+8)) {
						return
					}
				}
			}
		case 6:
			// repost count (assume just one #e)
			lastE := evt.Tags.Find("e")
			if lastE != nil {
				v := lastE[1]
				if nostr.IsValid32ByteHex(v) {
					p, _ := strconv.ParseInt(v[32:33], 16, 64)
					if !yield(v, int(p+8)) {
						return
					}
				}
			}
		case 7:
			// reaction count (assume just one #e)
			lastE := evt.Tags.Find("e")
			if lastE != nil {
				v := lastE[1]
				if nostr.IsValid32ByteHex(v) {
					p, _ := strconv.ParseInt(v[32:33], 16, 64)
					if !yield(v, int(p+8)) {
						return
					}
				}
			}
		case 1111:
			// comment count (#E, #e)
			eTag := evt.Tags.Find("E")
			if eTag != nil {
				v := eTag[1]
				if nostr.IsValid32ByteHex(v) {
					p, _ := strconv.ParseInt(v[32:33], 16, 64)
					if !yield(v, int(p+8)) {
						return
					}
				}
			}
			for eTag := range evt.Tags.FindAll("e") {
				v := eTag[1]
				if nostr.IsValid32ByteHex(v) {
					p, _ := strconv.ParseInt(v[32:33], 16, 64)
					if !yield(v, int(p+8)) {
						return
					}
				}
			}
			// quote count (#q)
			for qTag := range evt.Tags.FindAll("q") {
				v := qTag[1]
				if nostr.IsValid32ByteHex(v) {
					p, _ := strconv.ParseInt(v[32:33], 16, 64)
					if !yield(v, int(p+8)) {
						return
					}
				}
			}
		}
	}
}
