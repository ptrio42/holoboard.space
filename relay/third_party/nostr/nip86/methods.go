package nip86

import (
	"fmt"
	"math"
	"net"

	"fiatjaf.com/nostr"
)

func DecodeRequest(req Request) (MethodParams, error) {
	switch req.Method {
	case "supportedmethods":
		return SupportedMethods{}, nil
	case "banpubkey":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}

		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return BanPubKey{pk, reason}, nil
	case "listbannedpubkeys":
		return ListBannedPubKeys{}, nil
	case "unbanpubkey":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}

		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return UnbanPubKey{pk, reason}, nil
	case "allowpubkey":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}

		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return AllowPubKey{pk, reason}, nil
	case "listallowedpubkeys":
		return ListAllowedPubKeys{}, nil
	case "unallowpubkey":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}

		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return UnallowPubKey{pk, reason}, nil
	case "listeventsneedingmoderation":
		return ListEventsNeedingModeration{}, nil
	case "allowevent":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		idh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing id param for '%s'", req.Method)
		}
		id, err := nostr.IDFromHex(idh)
		if err != nil {
			return nil, fmt.Errorf("invalid id param for '%s'", req.Method)
		}

		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return AllowEvent{id, reason}, nil
	case "banevent":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		idh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing id param for '%s'", req.Method)
		}
		id, err := nostr.IDFromHex(idh)
		if err != nil {
			return nil, fmt.Errorf("invalid id param for '%s'", req.Method)
		}

		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return BanEvent{id, reason}, nil
	case "listbannedevents":
		return ListBannedEvents{}, nil
	case "listallowedevents":
		return ListAllowedEvents{}, nil
	case "listdisallowedkinds":
		return ListDisallowedKinds{}, nil
	case "changerelayname":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		name, _ := req.Params[0].(string)
		return ChangeRelayName{name}, nil
	case "changerelaydescription":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		desc, _ := req.Params[0].(string)
		return ChangeRelayDescription{desc}, nil
	case "changerelayicon":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		url, _ := req.Params[0].(string)
		return ChangeRelayIcon{url}, nil
	case "allowkind":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		kind, ok := req.Params[0].(float64)
		if !ok || math.Trunc(kind) != kind {
			return nil, fmt.Errorf("invalid kind '%v' for '%s'", req.Params[0], req.Method)
		}
		return AllowKind{nostr.Kind(kind)}, nil
	case "disallowkind":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		kind, ok := req.Params[0].(float64)
		if !ok || math.Trunc(kind) != kind {
			return nil, fmt.Errorf("invalid kind '%v' for '%s'", req.Params[0], req.Method)
		}
		return DisallowKind{nostr.Kind(kind)}, nil
	case "listallowedkinds":
		return ListAllowedKinds{}, nil
	case "blockip":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		ipstr, _ := req.Params[0].(string)
		ip := net.ParseIP(ipstr)
		if ip == nil {
			return nil, fmt.Errorf("invalid ip param for '%s'", req.Method)
		}
		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return BlockIP{ip, reason}, nil
	case "unblockip":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		ipstr, _ := req.Params[0].(string)
		ip := net.ParseIP(ipstr)
		if ip == nil {
			return nil, fmt.Errorf("invalid ip param for '%s'", req.Method)
		}
		var reason string
		if len(req.Params) >= 2 {
			reason, _ = req.Params[1].(string)
		}
		return UnblockIP{ip, reason}, nil
	case "listblockedips":
		return ListBlockedIPs{}, nil
	case "grantadmin":
		if len(req.Params) < 2 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}

		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}

		allowedMethods := req.Params[1].([]string)

		return GrantAdmin{
			Pubkey:       pk,
			AllowMethods: allowedMethods,
		}, nil
	case "revokeadmin":
		if len(req.Params) < 2 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}

		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}

		disallowedMethods := req.Params[1].([]string)

		return RevokeAdmin{
			Pubkey:          pk,
			DisallowMethods: disallowedMethods,
		}, nil
	case "createrole":
		if len(req.Params) < 5 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		id, _ := req.Params[0].(string)
		label, _ := req.Params[1].(string)
		description, _ := req.Params[2].(string)
		hue, _ := req.Params[3].(float64)
		order, ok := req.Params[4].(float64)
		if !ok || math.Trunc(order) != order {
			return nil, fmt.Errorf("invalid order param for '%s'", req.Method)
		}
		return CreateRole{id, label, description, int(hue), int(order)}, nil
	case "editrole":
		if len(req.Params) < 5 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		id, _ := req.Params[0].(string)
		label, _ := req.Params[1].(string)
		description, _ := req.Params[2].(string)
		hue, _ := req.Params[3].(float64)
		order, ok := req.Params[4].(float64)
		if !ok || math.Trunc(order) != order {
			return nil, fmt.Errorf("invalid order param for '%s'", req.Method)
		}
		return EditRole{id, label, description, int(hue), int(order)}, nil
	case "deleterole":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		id, _ := req.Params[0].(string)
		return DeleteRole{id}, nil
	case "assignrole":
		if len(req.Params) < 2 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}
		roleID, _ := req.Params[1].(string)
		return AssignRole{pk, roleID}, nil
	case "unassignrole":
		if len(req.Params) < 2 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}
		roleID, _ := req.Params[1].(string)
		return UnassignRole{pk, roleID}, nil
	case "assignmethod":
		if len(req.Params) < 2 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}
		method, ok := req.Params[1].(string)
		if !ok {
			return nil, fmt.Errorf("missing method param for '%s'", req.Method)
		}
		return AssignMethod{pk, method}, nil
	case "unassignmethod":
		if len(req.Params) < 2 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		pkh, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing pubkey param for '%s'", req.Method)
		}
		pk, err := nostr.PubKeyFromHex(pkh)
		if err != nil {
			return nil, fmt.Errorf("invalid pubkey param for '%s'", req.Method)
		}
		method, ok := req.Params[1].(string)
		if !ok {
			return nil, fmt.Errorf("missing method param for '%s'", req.Method)
		}
		return UnassignMethod{pk, method}, nil
	case "listclaims":
		return ListClaims{}, nil
	case "createclaim":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		claim, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing claim param for '%s'", req.Method)
		}
		return CreateClaim{claim}, nil
	case "deleteclaim":
		if len(req.Params) == 0 {
			return nil, fmt.Errorf("invalid number of params for '%s'", req.Method)
		}
		claim, ok := req.Params[0].(string)
		if !ok {
			return nil, fmt.Errorf("missing claim param for '%s'", req.Method)
		}
		return DeleteClaim{claim}, nil
	case "stats":
		return Stats{}, nil
	default:
		return nil, fmt.Errorf("unknown method '%s'", req.Method)
	}
}

// coerceTags converts a decoded JSON value (an array of arrays of strings) into
// nostr.Tags. A nil value yields nil tags; any other shape is an error.
func coerceTags(v any) (nostr.Tags, error) {
	if v == nil {
		return nil, nil
	}
	rawTags, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("tags must be an array")
	}
	tags := make(nostr.Tags, len(rawTags))
	for i, rt := range rawTags {
		rawTag, ok := rt.([]any)
		if !ok {
			return nil, fmt.Errorf("tag %d must be an array", i)
		}
		tag := make(nostr.Tag, len(rawTag))
		for j, el := range rawTag {
			s, ok := el.(string)
			if !ok {
				return nil, fmt.Errorf("tag %d element %d must be a string", i, j)
			}
			tag[j] = s
		}
		tags[i] = tag
	}
	return tags, nil
}

type MethodParams interface {
	MethodName() string
}

var (
	_ MethodParams = (*SupportedMethods)(nil)
	_ MethodParams = (*BanPubKey)(nil)
	_ MethodParams = (*ListBannedPubKeys)(nil)
	_ MethodParams = (*UnbanPubKey)(nil)
	_ MethodParams = (*AllowPubKey)(nil)
	_ MethodParams = (*ListAllowedPubKeys)(nil)
	_ MethodParams = (*UnallowPubKey)(nil)
	_ MethodParams = (*ListEventsNeedingModeration)(nil)
	_ MethodParams = (*AllowEvent)(nil)
	_ MethodParams = (*BanEvent)(nil)
	_ MethodParams = (*ListBannedEvents)(nil)
	_ MethodParams = (*ChangeRelayName)(nil)
	_ MethodParams = (*ChangeRelayDescription)(nil)
	_ MethodParams = (*ChangeRelayIcon)(nil)
	_ MethodParams = (*AllowKind)(nil)
	_ MethodParams = (*DisallowKind)(nil)
	_ MethodParams = (*ListAllowedKinds)(nil)
	_ MethodParams = (*BlockIP)(nil)
	_ MethodParams = (*UnblockIP)(nil)
	_ MethodParams = (*ListBlockedIPs)(nil)
	_ MethodParams = (*ListAllowedEvents)(nil)
	_ MethodParams = (*ListDisallowedKinds)(nil)
	_ MethodParams = (*GrantAdmin)(nil)
	_ MethodParams = (*RevokeAdmin)(nil)
	_ MethodParams = (*CreateRole)(nil)
	_ MethodParams = (*EditRole)(nil)
	_ MethodParams = (*DeleteRole)(nil)
	_ MethodParams = (*AssignRole)(nil)
	_ MethodParams = (*UnassignRole)(nil)
	_ MethodParams = (*AssignMethod)(nil)
	_ MethodParams = (*UnassignMethod)(nil)
	_ MethodParams = (*ListClaims)(nil)
	_ MethodParams = (*CreateClaim)(nil)
	_ MethodParams = (*DeleteClaim)(nil)
	_ MethodParams = (*Stats)(nil)
)

type SupportedMethods struct{}

func (SupportedMethods) MethodName() string { return "supportedmethods" }

type BanPubKey struct {
	PubKey nostr.PubKey
	Reason string
}

func (BanPubKey) MethodName() string { return "banpubkey" }

type ListBannedPubKeys struct{}

func (ListBannedPubKeys) MethodName() string { return "listbannedpubkeys" }

type UnbanPubKey struct {
	PubKey nostr.PubKey
	Reason string
}

func (UnbanPubKey) MethodName() string { return "unbanpubkey" }

type AllowPubKey struct {
	PubKey nostr.PubKey
	Reason string
}

func (AllowPubKey) MethodName() string { return "allowpubkey" }

type ListAllowedPubKeys struct{}

func (ListAllowedPubKeys) MethodName() string { return "listallowedpubkeys" }

type UnallowPubKey struct {
	PubKey nostr.PubKey
	Reason string
}

func (UnallowPubKey) MethodName() string { return "unallowpubkey" }

type ListEventsNeedingModeration struct{}

func (ListEventsNeedingModeration) MethodName() string { return "listeventsneedingmoderation" }

type AllowEvent struct {
	ID     nostr.ID
	Reason string
}

func (AllowEvent) MethodName() string { return "allowevent" }

type BanEvent struct {
	ID     nostr.ID
	Reason string
}

func (BanEvent) MethodName() string { return "banevent" }

type ListBannedEvents struct{}

func (ListBannedEvents) MethodName() string { return "listbannedevents" }

type ChangeRelayName struct {
	Name string
}

func (ChangeRelayName) MethodName() string { return "changerelayname" }

type ChangeRelayDescription struct {
	Description string
}

func (ChangeRelayDescription) MethodName() string { return "changerelaydescription" }

type ChangeRelayIcon struct {
	IconURL string
}

func (ChangeRelayIcon) MethodName() string { return "changerelayicon" }

type AllowKind struct {
	Kind nostr.Kind
}

func (AllowKind) MethodName() string { return "allowkind" }

type DisallowKind struct {
	Kind nostr.Kind
}

func (DisallowKind) MethodName() string { return "disallowkind" }

type ListAllowedKinds struct{}

func (ListAllowedKinds) MethodName() string { return "listallowedkinds" }

type BlockIP struct {
	IP     net.IP
	Reason string
}

func (BlockIP) MethodName() string { return "blockip" }

type UnblockIP struct {
	IP     net.IP
	Reason string
}

func (UnblockIP) MethodName() string { return "unblockip" }

type ListBlockedIPs struct{}

func (ListBlockedIPs) MethodName() string { return "listblockedips" }

type ListAllowedEvents struct{}

func (ListAllowedEvents) MethodName() string { return "listallowedevents" }

type ListDisallowedKinds struct{}

func (ListDisallowedKinds) MethodName() string { return "listdisallowedkinds" }

type GrantAdmin struct {
	Pubkey       nostr.PubKey
	AllowMethods []string
}

func (GrantAdmin) MethodName() string { return "grantadmin" }

type RevokeAdmin struct {
	Pubkey          nostr.PubKey
	DisallowMethods []string
}

func (RevokeAdmin) MethodName() string { return "revokeadmin" }

type CreateRole struct {
	ID          string
	Label       string
	Description string
	Hue         int
	Order       int
}

func (CreateRole) MethodName() string { return "createrole" }

type EditRole struct {
	ID          string
	Label       string
	Description string
	Hue         int
	Order       int
}

func (EditRole) MethodName() string { return "editrole" }

type DeleteRole struct {
	ID string
}

func (DeleteRole) MethodName() string { return "deleterole" }

type AssignRole struct {
	PubKey nostr.PubKey
	RoleID string
}

func (AssignRole) MethodName() string { return "assignrole" }

type UnassignRole struct {
	PubKey nostr.PubKey
	RoleID string
}

func (UnassignRole) MethodName() string { return "unassignrole" }

// AssignMethod grants a pubkey permission to use a single NIP-86 method.
type AssignMethod struct {
	PubKey nostr.PubKey
	Method string
}

func (AssignMethod) MethodName() string { return "assignmethod" }

// UnassignMethod revokes a pubkey's permission to use a single NIP-86 method.
type UnassignMethod struct {
	PubKey nostr.PubKey
	Method string
}

func (UnassignMethod) MethodName() string { return "unassignmethod" }

// ListClaims lists all NIP-43 invite codes ("claims") the relay knows about.
type ListClaims struct{}

func (ListClaims) MethodName() string { return "listclaims" }

// CreateClaim registers a NIP-43 invite code ("claim") that can later be
// redeemed to join the relay.
type CreateClaim struct {
	Claim string
}

func (CreateClaim) MethodName() string { return "createclaim" }

// DeleteClaim revokes a previously created NIP-43 invite code ("claim").
type DeleteClaim struct {
	Claim string
}

func (DeleteClaim) MethodName() string { return "deleteclaim" }

type Stats struct{}

func (Stats) MethodName() string { return "stats" }
