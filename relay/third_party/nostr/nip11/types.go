package nip11

import (
	"strconv"

	"fiatjaf.com/nostr"
)

type RelayInformationDocument struct {
	URL string

	Name          string
	Description   string
	PubKey        *nostr.PubKey
	Self          *nostr.PubKey
	Contact       string
	SupportedNIPs []any
	Software      string
	Version       string

	Limitation     *RelayLimitationDocument
	RelayCountries []string
	LanguageTags   []string
	Tags           []string
	PostingPolicy  string
	PaymentsURL    string
	Fees           *RelayFeesDocument
	Retention      []*RelayRetentionDocument
	Icon           string
	Banner         string

	SupportedGrasps []string

	NIP29 *NIP29Document

	Malformed map[string]any
}

type NIP29Document struct {
	Subgroups bool `json:"subgroups"`
}

func (info *RelayInformationDocument) AddSupportedNIP(nip string) {
	for _, n := range info.SupportedNIPs {
		switch v := n.(type) {
		case int:
			if strconv.Itoa(v) == nip {
				return
			}
		case string:
			if v == nip {
				return
			}
		}
	}

	if n, err := strconv.Atoi(nip); err == nil {
		info.SupportedNIPs = append(info.SupportedNIPs, n)
	} else {
		info.SupportedNIPs = append(info.SupportedNIPs, nip)
	}
}

func (info *RelayInformationDocument) AddSupportedNIPs(numbers []string) {
	for _, n := range numbers {
		info.AddSupportedNIP(n)
	}
}

type RelayLimitationDocument struct {
	MaxMessageLength    int
	MaxSubscriptions    int
	MaxLimit            int
	DefaultLimit        int
	MaxSubidLength      int
	MaxEventTags        int
	MaxContentLength    int
	MinPowDifficulty    int
	CreatedAtLowerLimit int64
	CreatedAtUpperLimit int64
	AuthRequired        bool
	PaymentRequired     bool
	RestrictedWrites    bool
}

type RelayFeesDocument struct {
	Admission []struct {
		Amount int
		Unit   string
	}
	Subscription []struct {
		Amount int
		Unit   string
		Period int
	}
	Publication []struct {
		Kinds  []int
		Amount int
		Unit   string
	}
}

type RelayRetentionDocument struct {
	Time  int64
	Count int
	Kinds [][]int
}
