package khatru

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nip86"
)

type RelayManagementAPI struct {
	OnAPICall func(ctx context.Context, mp nip86.MethodParams) (reject bool, msg string)

	BanPubKey                   func(ctx context.Context, pubkey nostr.PubKey, reason string) error
	ListBannedPubKeys           func(ctx context.Context) ([]nip86.PubKeyReason, error)
	UnbanPubKey                 func(ctx context.Context, pubkey nostr.PubKey, reason string) error
	AllowPubKey                 func(ctx context.Context, pubkey nostr.PubKey, reason string) error
	ListAllowedPubKeys          func(ctx context.Context) ([]nip86.PubKeyReason, error)
	UnallowPubKey               func(ctx context.Context, pubkey nostr.PubKey, reason string) error
	ListEventsNeedingModeration func(ctx context.Context) ([]nip86.IDReason, error)
	AllowEvent                  func(ctx context.Context, id nostr.ID, reason string) error
	BanEvent                    func(ctx context.Context, id nostr.ID, reason string) error
	ListBannedEvents            func(ctx context.Context) ([]nip86.IDReason, error)
	ListAllowedEvents           func(ctx context.Context) ([]nip86.IDReason, error)
	ChangeRelayName             func(ctx context.Context, name string) error
	ChangeRelayDescription      func(ctx context.Context, desc string) error
	ChangeRelayIcon             func(ctx context.Context, icon string) error
	AllowKind                   func(ctx context.Context, kind nostr.Kind) error
	DisallowKind                func(ctx context.Context, kind nostr.Kind) error
	ListAllowedKinds            func(ctx context.Context) ([]nostr.Kind, error)
	ListDisallowedKinds         func(ctx context.Context) ([]nostr.Kind, error)
	BlockIP                     func(ctx context.Context, ip net.IP, reason string) error
	UnblockIP                   func(ctx context.Context, ip net.IP, reason string) error
	ListBlockedIPs              func(ctx context.Context) ([]nip86.IPReason, error)
	Stats                       func(ctx context.Context) (nip86.Response, error)
	GrantAdmin                  func(ctx context.Context, pubkey nostr.PubKey, methods []string) error
	RevokeAdmin                 func(ctx context.Context, pubkey nostr.PubKey, methods []string) error
	CreateRole                  func(ctx context.Context, id string, label string, description string, hue int, order int) error
	EditRole                    func(ctx context.Context, id string, label string, description string, hue int, order int) error
	DeleteRole                  func(ctx context.Context, id string) error
	AssignRole                  func(ctx context.Context, pubkey nostr.PubKey, roleID string) error
	UnassignRole                func(ctx context.Context, pubkey nostr.PubKey, roleID string) error
	AssignMethod                func(ctx context.Context, pubkey nostr.PubKey, method string) error
	UnassignMethod              func(ctx context.Context, pubkey nostr.PubKey, method string) error
	ListClaims                  func(ctx context.Context) ([]string, error)
	CreateClaim                 func(ctx context.Context, claim string) error
	DeleteClaim                 func(ctx context.Context, claim string) error
	Generic                     func(ctx context.Context, request nip86.Request) (nip86.Response, error)
}

func (rl *Relay) HandleNIP86(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/nostr+json+rpc")

	var (
		resp        nip86.Response
		ctx         = context.WithValue(r.Context(), httpRequestKey, r)
		req         nip86.Request
		mp          nip86.MethodParams
		evt         nostr.Event
		payloadHash [32]byte
	)

	payload, err := io.ReadAll(r.Body)
	if err != nil {
		resp.Error = "empty request"
		goto respond
	}
	payloadHash = sha256.Sum256(payload)

	{
		auth := r.Header.Get("Authorization")
		spl := strings.Split(auth, "Nostr ")
		if len(spl) != 2 {
			resp.Error = "missing auth"
			goto respond
		}

		evtj, err := base64.StdEncoding.DecodeString(spl[1])
		if err != nil {
			resp.Error = "invalid base64 auth"
			goto respond
		}
		if err := json.Unmarshal(evtj, &evt); err != nil {
			resp.Error = "invalid auth event json"
			goto respond
		}
		if !evt.VerifySignature() {
			resp.Error = "invalid auth event"
			goto respond
		}

		uTag := evt.Tags.Find("u")
		if uTag == nil {
			resp.Error = "missing \"u\" tag"
			goto respond
		}

		expected := nostr.NormalizeURL(rl.getBaseURL(r))
		got := nostr.NormalizeURL(uTag[1])
		if expected != got {
			resp.Error = fmt.Sprintf("invalid \"u\" tag, expected '%s', got '%s'", expected, got)
			goto respond
		}

		if pht := evt.Tags.FindWithValue("payload", nostr.HexEncodeToString(payloadHash[:])); pht == nil {
			resp.Error = "invalid auth event payload hash"
			goto respond
		}

		if evt.CreatedAt < nostr.Now()-30 {
			resp.Error = "auth event is too old"
			goto respond
		}
	}

	if err := json.Unmarshal(payload, &req); err != nil {
		resp.Error = "invalid json body"
		goto respond
	}

	mp, err = nip86.DecodeRequest(req)
	if err != nil {
		resp.Error = fmt.Sprintf("invalid params: %s", err)
		goto respond
	}

	ctx = context.WithValue(ctx, nip86HeaderAuthKey, evt.PubKey)
	if rl.ManagementAPI.OnAPICall != nil {
		if reject, msg := rl.ManagementAPI.OnAPICall(ctx, mp); reject {
			resp.Error = msg
			goto respond
		}
	}

	if _, ok := mp.(nip86.SupportedMethods); ok {
		mat := reflect.TypeOf(rl.ManagementAPI)
		mav := reflect.ValueOf(rl.ManagementAPI)

		methods := make([]string, 0, mat.NumField())
		for i := 0; i < mat.NumField(); i++ {
			field := mat.Field(i)
			value := mav.Field(i).Interface()

			// danger: this assumes the struct fields are appropriately named
			methodName := strings.ToLower(field.Name)

			// these fields are not NIP-86 methods
			if methodName == "onapicall" || methodName == "generic" {
				continue
			}

			// assign this only if the function was defined
			if !reflect.ValueOf(value).IsNil() {
				methods = append(methods, methodName)
			}
		}

		// Allow customizing supported methods by authenticated pubkey
		if rl.OverwriteSupportedMethods != nil {
			methods = rl.OverwriteSupportedMethods(ctx, methods)
		}

		resp.Result = methods
	} else {
		switch thing := mp.(type) {
		case nip86.BanPubKey:
			if rl.ManagementAPI.BanPubKey == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.BanPubKey(ctx, thing.PubKey, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ListBannedPubKeys:
			if rl.ManagementAPI.ListBannedPubKeys == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListBannedPubKeys(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.UnbanPubKey:
			if rl.ManagementAPI.UnbanPubKey == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.UnbanPubKey(ctx, thing.PubKey, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.AllowPubKey:
			if rl.ManagementAPI.AllowPubKey == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.AllowPubKey(ctx, thing.PubKey, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ListAllowedPubKeys:
			if rl.ManagementAPI.ListAllowedPubKeys == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListAllowedPubKeys(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.UnallowPubKey:
			if rl.ManagementAPI.UnallowPubKey == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.UnallowPubKey(ctx, thing.PubKey, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.BanEvent:
			if rl.ManagementAPI.BanEvent == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.BanEvent(ctx, thing.ID, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.AllowEvent:
			if rl.ManagementAPI.AllowEvent == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.AllowEvent(ctx, thing.ID, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ListEventsNeedingModeration:
			if rl.ManagementAPI.ListEventsNeedingModeration == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListEventsNeedingModeration(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.ListBannedEvents:
			if rl.ManagementAPI.ListBannedEvents == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListBannedEvents(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.ChangeRelayName:
			if rl.ManagementAPI.ChangeRelayName == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.ChangeRelayName(ctx, thing.Name); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ChangeRelayDescription:
			if rl.ManagementAPI.ChangeRelayDescription == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.ChangeRelayDescription(ctx, thing.Description); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ChangeRelayIcon:
			if rl.ManagementAPI.ChangeRelayIcon == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.ChangeRelayIcon(ctx, thing.IconURL); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.AllowKind:
			if rl.ManagementAPI.AllowKind == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.AllowKind(ctx, thing.Kind); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.DisallowKind:
			if rl.ManagementAPI.DisallowKind == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.DisallowKind(ctx, thing.Kind); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ListAllowedKinds:
			if rl.ManagementAPI.ListAllowedKinds == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListAllowedKinds(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.BlockIP:
			if rl.ManagementAPI.BlockIP == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.BlockIP(ctx, thing.IP, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.UnblockIP:
			if rl.ManagementAPI.UnblockIP == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.UnblockIP(ctx, thing.IP, thing.Reason); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ListBlockedIPs:
			if rl.ManagementAPI.ListBlockedIPs == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListBlockedIPs(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.Stats:
			if rl.ManagementAPI.Stats == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.Stats(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.GrantAdmin:
			if rl.ManagementAPI.GrantAdmin == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.GrantAdmin(ctx, thing.Pubkey, thing.AllowMethods); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.RevokeAdmin:
			if rl.ManagementAPI.RevokeAdmin == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.RevokeAdmin(ctx, thing.Pubkey, thing.DisallowMethods); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.CreateRole:
			if rl.ManagementAPI.CreateRole == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.CreateRole(ctx, thing.ID, thing.Label, thing.Description, thing.Hue, thing.Order); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.EditRole:
			if rl.ManagementAPI.EditRole == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.EditRole(ctx, thing.ID, thing.Label, thing.Description, thing.Hue, thing.Order); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.DeleteRole:
			if rl.ManagementAPI.DeleteRole == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.DeleteRole(ctx, thing.ID); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.AssignRole:
			if rl.ManagementAPI.AssignRole == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.AssignRole(ctx, thing.PubKey, thing.RoleID); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.UnassignRole:
			if rl.ManagementAPI.UnassignRole == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.UnassignRole(ctx, thing.PubKey, thing.RoleID); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.AssignMethod:
			if rl.ManagementAPI.AssignMethod == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.AssignMethod(ctx, thing.PubKey, thing.Method); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.UnassignMethod:
			if rl.ManagementAPI.UnassignMethod == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.UnassignMethod(ctx, thing.PubKey, thing.Method); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ListClaims:
			if rl.ManagementAPI.ListClaims == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListClaims(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.CreateClaim:
			if rl.ManagementAPI.CreateClaim == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.CreateClaim(ctx, thing.Claim); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.DeleteClaim:
			if rl.ManagementAPI.DeleteClaim == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if err := rl.ManagementAPI.DeleteClaim(ctx, thing.Claim); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = true
			}
		case nip86.ListDisallowedKinds:
			if rl.ManagementAPI.ListDisallowedKinds == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListDisallowedKinds(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		case nip86.ListAllowedEvents:
			if rl.ManagementAPI.ListAllowedEvents == nil {
				resp.Error = fmt.Sprintf("method %s not supported", thing.MethodName())
			} else if result, err := rl.ManagementAPI.ListAllowedEvents(ctx); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		default:
			if rl.ManagementAPI.Generic == nil {
				resp.Error = fmt.Sprintf("method '%s' not known", mp.MethodName())
			} else if result, err := rl.ManagementAPI.Generic(ctx, req); err != nil {
				resp.Error = err.Error()
			} else {
				resp.Result = result
			}
		}
	}

respond:
	json.NewEncoder(w).Encode(resp)
}
