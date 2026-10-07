package nip11

import (
	"encoding/json"

	"fiatjaf.com/nostr"
	jlexer "github.com/mailru/easyjson/jlexer"
	jwriter "github.com/mailru/easyjson/jwriter"
)

func easyjsonDecodeRelayInformationDocument(in *jlexer.Lexer, out *RelayInformationDocument) {
	isTopLevel := in.IsStart()
	if in.IsNull() {
		if isTopLevel {
			in.Consumed()
		}
		in.Skip()
		return
	}
	in.Delim('{')
	for !in.IsDelim('}') {
		key := in.UnsafeFieldName(false)
		in.WantColon()
		if in.IsNull() {
			in.Skip()
			in.WantComma()
			continue
		}
		switch key {
		case "name":
			out.Name = in.String()
			goto next
		case "description":
			out.Description = in.String()
			goto next
		case "pubkey":
			b := in.UnsafeBytes()
			if len(b) == 64 {
				key, err := nostr.PubKeyFromHexCheap(string(b))
				if err != nil {
					in.AddError(err)
				} else {
					out.PubKey = &key
				}
			}
			goto next
		case "self":
			b := in.UnsafeBytes()
			if len(b) == 64 {
				key, err := nostr.PubKeyFromHexCheap(string(b))
				if err != nil {
					in.AddError(err)
				} else {
					out.Self = &key
				}
			}
			goto next
		case "contact":
			out.Contact = in.String()
			goto next
		case "supported_nips":
			if in.IsDelim('[') {
				in.Delim('[')
				if out.SupportedNIPs == nil {
					if !in.IsDelim(']') {
						out.SupportedNIPs = make([]any, 0, 8)
					} else {
						out.SupportedNIPs = []any{}
					}
				} else {
					out.SupportedNIPs = (out.SupportedNIPs)[:0]
				}
				for !in.IsDelim(']') {
					v := in.Interface()
					if f, ok := v.(float64); ok {
						v = int(f)
					}
					out.SupportedNIPs = append(out.SupportedNIPs, v)
					in.WantComma()
				}
				in.Delim(']')
				goto next
			}
			// otherwise fall back to malformed
		case "software":
			out.Software = in.String()
			goto next
		case "version":
			out.Version = in.String()
			goto next
		case "limitation":
			if out.Limitation == nil {
				out.Limitation = new(RelayLimitationDocument)
			}
			easyjsonDecodeRelayLimitationDocument(in, out.Limitation)
			goto next
		case "relay_countries":
			in.Delim('[')
			if out.RelayCountries == nil {
				if !in.IsDelim(']') {
					out.RelayCountries = make([]string, 0, 4)
				} else {
					out.RelayCountries = []string{}
				}
			} else {
				out.RelayCountries = (out.RelayCountries)[:0]
			}
			for !in.IsDelim(']') {
				out.RelayCountries = append(out.RelayCountries, in.String())
				in.WantComma()
			}
			in.Delim(']')
			goto next
		case "language_tags":
			in.Delim('[')
			if out.LanguageTags == nil {
				if !in.IsDelim(']') {
					out.LanguageTags = make([]string, 0, 4)
				} else {
					out.LanguageTags = []string{}
				}
			} else {
				out.LanguageTags = (out.LanguageTags)[:0]
			}
			for !in.IsDelim(']') {
				out.LanguageTags = append(out.LanguageTags, in.String())
				in.WantComma()
			}
			in.Delim(']')
			goto next
		case "tags":
			in.Delim('[')
			if out.Tags == nil {
				if !in.IsDelim(']') {
					out.Tags = make([]string, 0, 4)
				} else {
					out.Tags = []string{}
				}
			} else {
				out.Tags = (out.Tags)[:0]
			}
			for !in.IsDelim(']') {
				out.Tags = append(out.Tags, in.String())
				in.WantComma()
			}
			in.Delim(']')
			goto next
		case "posting_policy":
			out.PostingPolicy = in.String()
			goto next
		case "payments_url":
			out.PaymentsURL = in.String()
			goto next
		case "fees":
			if out.Fees == nil {
				out.Fees = new(RelayFeesDocument)
			}
			easyjsonDecodeRelayFeesDocument(in, out.Fees)
			goto next
		case "retention":
			in.Delim('[')
			if out.Retention == nil {
				if !in.IsDelim(']') {
					out.Retention = make([]*RelayRetentionDocument, 0, 2)
				} else {
					out.Retention = []*RelayRetentionDocument{}
				}
			} else {
				out.Retention = (out.Retention)[:0]
			}
			for !in.IsDelim(']') {
				var v RelayRetentionDocument
				easyjsonDecodeRelayRetentionDocument(in, &v)
				out.Retention = append(out.Retention, &v)
				in.WantComma()
			}
			in.Delim(']')
			goto next
		case "icon":
			out.Icon = in.String()
			goto next
		case "banner":
			out.Banner = in.String()
			goto next
		case "supported_grasps":
			in.Delim('[')
			if out.SupportedGrasps == nil {
				if !in.IsDelim(']') {
					out.SupportedGrasps = make([]string, 0, 4)
				} else {
					out.SupportedGrasps = []string{}
				}
			} else {
				out.SupportedGrasps = (out.SupportedGrasps)[:0]
			}
			for !in.IsDelim(']') {
				out.SupportedGrasps = append(out.SupportedGrasps, in.String())
				in.WantComma()
			}
			in.Delim(']')
			goto next
		case "nip29":
			if out.NIP29 == nil {
				out.NIP29 = new(NIP29Document)
			}
			easyjsonDecodeNIP29Document(in, out.NIP29)
			goto next
		}

		if out.Malformed == nil {
			out.Malformed = make(map[string]any)
		}
		out.Malformed[key] = in.Interface()

	next:
		in.WantComma()
	}
	in.Delim('}')
	if isTopLevel {
		in.Consumed()
	}
}

func easyjsonEncodeRelayInformationDocument(out *jwriter.Writer, in RelayInformationDocument) {
	out.RawByte('{')
	first := true
	_ = first
	if in.Name != "" {
		const prefix string = ",\"name\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.Name)
		delete(in.Malformed, "name")
	} else if v, ok := in.Malformed["name"]; ok {
		const prefix string = ",\"name\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "name")
	}
	if in.Description != "" {
		const prefix string = ",\"description\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.Description)
		delete(in.Malformed, "description")
	} else if v, ok := in.Malformed["description"]; ok {
		const prefix string = ",\"description\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "description")
	}
	if in.PubKey != nil {
		const prefix string = ",\"pubkey\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.RawString("\"" + nostr.HexEncodeToString(in.PubKey[:]) + "\"")
		delete(in.Malformed, "pubkey")
	} else if v, ok := in.Malformed["pubkey"]; ok {
		const prefix string = ",\"pubkey\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "pubkey")
	}
	if in.Self != nil {
		const prefix string = ",\"self\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.RawString("\"" + nostr.HexEncodeToString(in.Self[:]) + "\"")
		delete(in.Malformed, "self")
	} else if v, ok := in.Malformed["self"]; ok {
		const prefix string = ",\"self\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "self")
	}
	if in.Contact != "" {
		const prefix string = ",\"contact\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.Contact)
		delete(in.Malformed, "contact")
	} else if v, ok := in.Malformed["contact"]; ok {
		const prefix string = ",\"contact\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "contact")
	}
	if len(in.SupportedNIPs) != 0 {
		const prefix string = ",\"supported_nips\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.SupportedNIPs {
				if i > 0 {
					out.RawByte(',')
				}
				switch val := v.(type) {
				case int:
					out.Int(val)
				case string:
					out.String(val)
				default:
					out.Int(0)
				}
			}
			out.RawByte(']')
		}
		delete(in.Malformed, "supported_nips")
	} else if v, ok := in.Malformed["supported_nips"]; ok {
		const prefix string = ",\"supported_nips\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "supported_nips")
	}
	if in.Software != "" {
		const prefix string = ",\"software\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.Software)
		delete(in.Malformed, "software")
	} else if v, ok := in.Malformed["software"]; ok {
		const prefix string = ",\"software\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "software")
	}
	if in.Version != "" {
		const prefix string = ",\"version\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.Version)
		delete(in.Malformed, "version")
	} else if v, ok := in.Malformed["version"]; ok {
		const prefix string = ",\"version\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "version")
	}
	if in.Limitation != nil {
		const prefix string = ",\"limitation\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		easyjsonEncodeRelayLimitationDocument(out, *in.Limitation)
		delete(in.Malformed, "limitation")
	} else if v, ok := in.Malformed["limitation"]; ok {
		const prefix string = ",\"limitation\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "limitation")
	}
	if len(in.RelayCountries) != 0 {
		const prefix string = ",\"relay_countries\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.RelayCountries {
				if i > 0 {
					out.RawByte(',')
				}
				out.String(v)
			}
			out.RawByte(']')
		}
		delete(in.Malformed, "relay_countries")
	} else if v, ok := in.Malformed["relay_countries"]; ok {
		const prefix string = ",\"relay_countries\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "relay_countries")
	}
	if len(in.LanguageTags) != 0 {
		const prefix string = ",\"language_tags\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.LanguageTags {
				if i > 0 {
					out.RawByte(',')
				}
				out.String(v)
			}
			out.RawByte(']')
		}
		delete(in.Malformed, "language_tags")
	} else if v, ok := in.Malformed["language_tags"]; ok {
		const prefix string = ",\"language_tags\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "language_tags")
	}
	if len(in.Tags) != 0 {
		const prefix string = ",\"tags\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.Tags {
				if i > 0 {
					out.RawByte(',')
				}
				out.String(v)
			}
			out.RawByte(']')
		}
		delete(in.Malformed, "tags")
	} else if v, ok := in.Malformed["tags"]; ok {
		const prefix string = ",\"tags\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "tags")
	}
	if in.PostingPolicy != "" {
		const prefix string = ",\"posting_policy\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.PostingPolicy)
		delete(in.Malformed, "posting_policy")
	} else if v, ok := in.Malformed["posting_policy"]; ok {
		const prefix string = ",\"posting_policy\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "posting_policy")
	}
	if in.PaymentsURL != "" {
		const prefix string = ",\"payments_url\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.PaymentsURL)
		delete(in.Malformed, "payments_url")
	} else if v, ok := in.Malformed["payments_url"]; ok {
		const prefix string = ",\"payments_url\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "payments_url")
	}
	if in.Fees != nil {
		const prefix string = ",\"fees\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		easyjsonEncodeRelayFeesDocument(out, *in.Fees)
		delete(in.Malformed, "fees")
	} else if v, ok := in.Malformed["fees"]; ok {
		const prefix string = ",\"fees\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "fees")
	}
	if len(in.Retention) != 0 {
		const prefix string = ",\"retention\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.Retention {
				if i > 0 {
					out.RawByte(',')
				}
				if v == nil {
					out.RawString("null")
				} else {
					easyjsonEncodeRelayRetentionDocument(out, *v)
				}
			}
			out.RawByte(']')
		}
		delete(in.Malformed, "retention")
	} else if v, ok := in.Malformed["retention"]; ok {
		const prefix string = ",\"retention\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "retention")
	}
	if in.Icon != "" {
		const prefix string = ",\"icon\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.Icon)
		delete(in.Malformed, "icon")
	} else if v, ok := in.Malformed["icon"]; ok {
		const prefix string = ",\"icon\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "icon")
	}
	if in.Banner != "" {
		const prefix string = ",\"banner\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.String(in.Banner)
		delete(in.Malformed, "banner")
	} else if v, ok := in.Malformed["banner"]; ok {
		const prefix string = ",\"banner\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "banner")
	}
	if len(in.SupportedGrasps) != 0 {
		const prefix string = ",\"supported_grasps\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.SupportedGrasps {
				if i > 0 {
					out.RawByte(',')
				}
				out.String(v)
			}
			out.RawByte(']')
		}
		delete(in.Malformed, "supported_grasps")
	} else if v, ok := in.Malformed["supported_grasps"]; ok {
		const prefix string = ",\"supported_grasps\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "supported_grasps")
	}
	if in.NIP29 != nil {
		const prefix string = ",\"nip29\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		easyjsonEncodeNIP29Document(out, *in.NIP29)
		delete(in.Malformed, "nip29")
	} else if v, ok := in.Malformed["nip29"]; ok {
		const prefix string = ",\"nip29\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		encodeAny(out, v)
		delete(in.Malformed, "nip29")
	}
	for key, v := range in.Malformed {
		if first {
			first = false
			out.RawString("\"" + key + "\":")
		} else {
			out.RawString(",\"" + key + "\":")
		}
		encodeAny(out, v)
	}
	out.RawByte('}')
}

func encodeAny(out *jwriter.Writer, v any) {
	switch val := v.(type) {
	case nil:
		out.RawString("null")
	case bool:
		out.Bool(val)
	case int:
		out.Int(val)
	case int8:
		out.Int8(val)
	case int16:
		out.Int16(val)
	case int32:
		out.Int32(val)
	case int64:
		out.Int64(val)
	case uint:
		out.Uint(val)
	case uint8:
		out.Uint8(val)
	case uint16:
		out.Uint16(val)
	case uint32:
		out.Uint32(val)
	case uint64:
		out.Uint64(val)
	case float32:
		out.Float32(val)
	case float64:
		out.Float64(val)
	case string:
		out.String(val)
	case []any:
		out.RawByte('[')
		for i, elem := range val {
			if i > 0 {
				out.RawByte(',')
			}
			encodeAny(out, elem)
		}
		out.RawByte(']')
	case map[string]any:
		out.RawByte('{')
		first := true
		for k, elem := range val {
			if first {
				first = false
			} else {
				out.RawByte(',')
			}
			out.String(k)
			out.RawByte(':')
			encodeAny(out, elem)
		}
		out.RawByte('}')
	default:
		// marshal via standard library as fallback
		b, _ := json.Marshal(val)
		out.RawString(string(b))
	}
}

// MarshalJSON supports json.Marshaler interface
func (v RelayInformationDocument) MarshalJSON() ([]byte, error) {
	w := jwriter.Writer{NoEscapeHTML: true}
	easyjsonEncodeRelayInformationDocument(&w, v)
	return w.Buffer.BuildBytes(), w.Error
}

// MarshalEasyJSON supports easyjson.Marshaler interface
func (v RelayInformationDocument) MarshalEasyJSON(w *jwriter.Writer) {
	w.NoEscapeHTML = true
	easyjsonEncodeRelayInformationDocument(w, v)
}

// UnmarshalJSON supports json.Unmarshaler interface
func (v *RelayInformationDocument) UnmarshalJSON(data []byte) error {
	r := jlexer.Lexer{Data: data}
	easyjsonDecodeRelayInformationDocument(&r, v)
	return r.Error()
}

// UnmarshalEasyJSON supports easyjson.Unmarshaler interface
func (v *RelayInformationDocument) UnmarshalEasyJSON(l *jlexer.Lexer) {
	easyjsonDecodeRelayInformationDocument(l, v)
}

func easyjsonDecodeRelayLimitationDocument(in *jlexer.Lexer, out *RelayLimitationDocument) {
	if in.IsNull() {
		in.Skip()
		return
	}
	in.Delim('{')
	for !in.IsDelim('}') {
		key := in.UnsafeFieldName(false)
		in.WantColon()
		if in.IsNull() {
			in.Skip()
			in.WantComma()
			continue
		}
		switch key {
		case "max_message_length":
			out.MaxMessageLength = in.Int()
		case "max_subscriptions":
			out.MaxSubscriptions = in.Int()
		case "max_limit":
			out.MaxLimit = in.Int()
		case "default_limit":
			out.DefaultLimit = in.Int()
		case "max_subid_length":
			out.MaxSubidLength = in.Int()
		case "max_event_tags":
			out.MaxEventTags = in.Int()
		case "max_content_length":
			out.MaxContentLength = in.Int()
		case "min_pow_difficulty":
			out.MinPowDifficulty = in.Int()
		case "created_at_lower_limit":
			out.CreatedAtLowerLimit = in.Int64()
		case "created_at_upper_limit":
			out.CreatedAtUpperLimit = in.Int64()
		case "auth_required":
			out.AuthRequired = in.Bool()
		case "payment_required":
			out.PaymentRequired = in.Bool()
		case "restricted_writes":
			out.RestrictedWrites = in.Bool()
		default:
			in.SkipRecursive()
		}
		in.WantComma()
	}
	in.Delim('}')
}

func easyjsonEncodeRelayLimitationDocument(out *jwriter.Writer, in RelayLimitationDocument) {
	out.RawByte('{')
	first := true
	_ = first
	if in.MaxMessageLength != 0 {
		const prefix string = ",\"max_message_length\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.MaxMessageLength)
	}
	if in.MaxSubscriptions != 0 {
		const prefix string = ",\"max_subscriptions\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.MaxSubscriptions)
	}
	if in.MaxLimit != 0 {
		const prefix string = ",\"max_limit\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.MaxLimit)
	}
	if in.DefaultLimit != 0 {
		const prefix string = ",\"default_limit\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.DefaultLimit)
	}
	if in.MaxSubidLength != 0 {
		const prefix string = ",\"max_subid_length\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.MaxSubidLength)
	}
	if in.MaxEventTags != 0 {
		const prefix string = ",\"max_event_tags\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.MaxEventTags)
	}
	if in.MaxContentLength != 0 {
		const prefix string = ",\"max_content_length\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.MaxContentLength)
	}
	if in.MinPowDifficulty != 0 {
		const prefix string = ",\"min_pow_difficulty\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.MinPowDifficulty)
	}
	{
		const prefix string = ",\"created_at_lower_limit\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int64(in.CreatedAtLowerLimit)
	}
	{
		const prefix string = ",\"created_at_upper_limit\":"
		out.RawString(prefix)
		out.Int64(in.CreatedAtUpperLimit)
	}
	{
		const prefix string = ",\"auth_required\":"
		out.RawString(prefix)
		out.Bool(in.AuthRequired)
	}
	{
		const prefix string = ",\"payment_required\":"
		out.RawString(prefix)
		out.Bool(in.PaymentRequired)
	}
	{
		const prefix string = ",\"restricted_writes\":"
		out.RawString(prefix)
		out.Bool(in.RestrictedWrites)
	}
	out.RawByte('}')
}

func easyjsonDecodeRelayFeesDocument(in *jlexer.Lexer, out *RelayFeesDocument) {
	if in.IsNull() {
		in.Skip()
		return
	}
	in.Delim('{')
	for !in.IsDelim('}') {
		key := in.UnsafeFieldName(false)
		in.WantColon()
		if in.IsNull() {
			in.Skip()
			in.WantComma()
			continue
		}
		switch key {
		case "admission":
			in.Delim('[')
			if out.Admission == nil {
				if !in.IsDelim(']') {
					out.Admission = make([]struct {
						Amount int
						Unit   string
					}, 0, 2)
				} else {
					out.Admission = []struct {
						Amount int
						Unit   string
					}{}
				}
			} else {
				out.Admission = (out.Admission)[:0]
			}
			for !in.IsDelim(']') {
				var v struct {
					Amount int
					Unit   string
				}
				in.Delim('{')
				for !in.IsDelim('}') {
					k := in.UnsafeFieldName(false)
					in.WantColon()
					if in.IsNull() {
						in.Skip()
						in.WantComma()
						continue
					}
					switch k {
					case "amount":
						v.Amount = in.Int()
					case "unit":
						v.Unit = in.String()
					default:
						in.SkipRecursive()
					}
					in.WantComma()
				}
				in.Delim('}')
				out.Admission = append(out.Admission, v)
				in.WantComma()
			}
			in.Delim(']')
		case "subscription":
			in.Delim('[')
			if out.Subscription == nil {
				if !in.IsDelim(']') {
					out.Subscription = make([]struct {
						Amount int
						Unit   string
						Period int
					}, 0, 2)
				} else {
					out.Subscription = []struct {
						Amount int
						Unit   string
						Period int
					}{}
				}
			} else {
				out.Subscription = (out.Subscription)[:0]
			}
			for !in.IsDelim(']') {
				var v struct {
					Amount int
					Unit   string
					Period int
				}
				in.Delim('{')
				for !in.IsDelim('}') {
					k := in.UnsafeFieldName(false)
					in.WantColon()
					if in.IsNull() {
						in.Skip()
						in.WantComma()
						continue
					}
					switch k {
					case "amount":
						v.Amount = in.Int()
					case "unit":
						v.Unit = in.String()
					case "period":
						v.Period = in.Int()
					default:
						in.SkipRecursive()
					}
					in.WantComma()
				}
				in.Delim('}')
				out.Subscription = append(out.Subscription, v)
				in.WantComma()
			}
			in.Delim(']')
		case "publication":
			in.Delim('[')
			if out.Publication == nil {
				if !in.IsDelim(']') {
					out.Publication = make([]struct {
						Kinds  []int
						Amount int
						Unit   string
					}, 0, 2)
				} else {
					out.Publication = []struct {
						Kinds  []int
						Amount int
						Unit   string
					}{}
				}
			} else {
				out.Publication = (out.Publication)[:0]
			}
			for !in.IsDelim(']') {
				var v struct {
					Kinds  []int
					Amount int
					Unit   string
				}
				in.Delim('{')
				for !in.IsDelim('}') {
					k := in.UnsafeFieldName(false)
					in.WantColon()
					if in.IsNull() {
						in.Skip()
						in.WantComma()
						continue
					}
					switch k {
					case "kinds":
						in.Delim('[')
						if v.Kinds == nil {
							if !in.IsDelim(']') {
								v.Kinds = make([]int, 0, 4)
							} else {
								v.Kinds = []int{}
							}
						} else {
							v.Kinds = (v.Kinds)[:0]
						}
						for !in.IsDelim(']') {
							v.Kinds = append(v.Kinds, in.Int())
							in.WantComma()
						}
						in.Delim(']')
					case "amount":
						v.Amount = in.Int()
					case "unit":
						v.Unit = in.String()
					default:
						in.SkipRecursive()
					}
					in.WantComma()
				}
				in.Delim('}')
				out.Publication = append(out.Publication, v)
				in.WantComma()
			}
			in.Delim(']')
		default:
			in.SkipRecursive()
		}
		in.WantComma()
	}
	in.Delim('}')
}

func easyjsonEncodeRelayFeesDocument(out *jwriter.Writer, in RelayFeesDocument) {
	out.RawByte('{')
	first := true
	_ = first
	if len(in.Admission) != 0 {
		const prefix string = ",\"admission\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.Admission {
				if i > 0 {
					out.RawByte(',')
				}
				out.RawByte('{')
				out.RawString("\"amount\":")
				out.Int(v.Amount)
				if v.Unit != "" {
					out.RawString(",\"unit\":")
					out.String(v.Unit)
				}
				out.RawByte('}')
			}
			out.RawByte(']')
		}
	}
	if len(in.Subscription) != 0 {
		const prefix string = ",\"subscription\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.Subscription {
				if i > 0 {
					out.RawByte(',')
				}
				out.RawByte('{')
				out.RawString("\"amount\":")
				out.Int(v.Amount)
				if v.Unit != "" {
					out.RawString(",\"unit\":")
					out.String(v.Unit)
				}
				if v.Period != 0 {
					out.RawString(",\"period\":")
					out.Int(v.Period)
				}
				out.RawByte('}')
			}
			out.RawByte(']')
		}
	}
	if len(in.Publication) != 0 {
		const prefix string = ",\"publication\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, v := range in.Publication {
				if i > 0 {
					out.RawByte(',')
				}
				out.RawByte('{')
				out.RawString("\"kinds\":")
				{
					out.RawByte('[')
					for j, k := range v.Kinds {
						if j > 0 {
							out.RawByte(',')
						}
						out.Int(k)
					}
					out.RawByte(']')
				}
				out.RawString(",\"amount\":")
				out.Int(v.Amount)
				if v.Unit != "" {
					out.RawString(",\"unit\":")
					out.String(v.Unit)
				}
				out.RawByte('}')
			}
			out.RawByte(']')
		}
	}
	out.RawByte('}')
}

func easyjsonDecodeRelayRetentionDocument(in *jlexer.Lexer, out *RelayRetentionDocument) {
	if in.IsNull() {
		in.Skip()
		return
	}
	in.Delim('{')
	for !in.IsDelim('}') {
		key := in.UnsafeFieldName(false)
		in.WantColon()
		if in.IsNull() {
			in.Skip()
			in.WantComma()
			continue
		}
		switch key {
		case "time":
			out.Time = in.Int64()
		case "count":
			out.Count = in.Int()
		case "kinds":
			in.Delim('[')
			if out.Kinds == nil {
				if !in.IsDelim(']') {
					out.Kinds = make([][]int, 0, 2)
				} else {
					out.Kinds = [][]int{}
				}
			} else {
				out.Kinds = (out.Kinds)[:0]
			}
			for !in.IsDelim(']') {
				var v []int
				in.Delim('[')
				if !in.IsDelim(']') {
					v = make([]int, 0, 4)
				} else {
					v = []int{}
				}
				for !in.IsDelim(']') {
					v = append(v, in.Int())
					in.WantComma()
				}
				in.Delim(']')
				out.Kinds = append(out.Kinds, v)
				in.WantComma()
			}
			in.Delim(']')
		default:
			in.SkipRecursive()
		}
		in.WantComma()
	}
	in.Delim('}')
}

func easyjsonEncodeRelayRetentionDocument(out *jwriter.Writer, in RelayRetentionDocument) {
	out.RawByte('{')
	first := true
	_ = first
	if in.Time != 0 {
		const prefix string = ",\"time\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int64(in.Time)
	}
	if in.Count != 0 {
		const prefix string = ",\"count\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Int(in.Count)
	}
	if len(in.Kinds) != 0 {
		const prefix string = ",\"kinds\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		{
			out.RawByte('[')
			for i, kinds := range in.Kinds {
				if i > 0 {
					out.RawByte(',')
				}
				out.RawByte('[')
				for j, k := range kinds {
					if j > 0 {
						out.RawByte(',')
					}
					out.Int(k)
				}
				out.RawByte(']')
			}
			out.RawByte(']')
		}
	}
	out.RawByte('}')
}

func easyjsonDecodeNIP29Document(in *jlexer.Lexer, out *NIP29Document) {
	if in.IsNull() {
		in.Skip()
		return
	}
	in.Delim('{')
	for !in.IsDelim('}') {
		key := in.UnsafeFieldName(false)
		in.WantColon()
		if in.IsNull() {
			in.Skip()
			in.WantComma()
			continue
		}
		switch key {
		case "subgroups":
			out.Subgroups = in.Bool()
		default:
			in.SkipRecursive()
		}
		in.WantComma()
	}
	in.Delim('}')
}

func easyjsonEncodeNIP29Document(out *jwriter.Writer, in NIP29Document) {
	out.RawByte('{')
	first := true
	_ = first
	if in.Subgroups {
		const prefix string = ",\"subgroups\":"
		if first {
			first = false
			out.RawString(prefix[1:])
		} else {
			out.RawString(prefix)
		}
		out.Bool(in.Subgroups)
	}
	out.RawByte('}')
}
