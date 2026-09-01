package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip04"
)

// maxDMBacklog caps how far back a restart looks for DMs it may have missed.
// Shorter than the mention backlog on purpose: answering a stale mention costs
// a reply, answering a stale PROMOTE costs a Lightning invoice.
const maxDMBacklog = 1 * time.Hour

// DMMonitor monitors external relays for DMs sent to the relay
type DMMonitor struct {
	relays         []string
	relayPubkey    string
	relayPrivkey   string
	invoiceManager *InvoiceManager
	storage        *Storage // Use persistent storage for DM tracking
	// adminPubkey may take a note off the board. Empty means nobody can, and
	// the commands answer as though they do not exist.
	adminPubkey string
}

// NewDMMonitor creates a new DM monitor
func NewDMMonitor(relays []string, relayPubkey, relayPrivkey string, invoiceManager *InvoiceManager, storage *Storage) *DMMonitor {
	return &DMMonitor{
		relays:         relays,
		relayPubkey:    relayPubkey,
		relayPrivkey:   relayPrivkey,
		invoiceManager: invoiceManager,
		storage:        storage,
	}
}

// WithAdmin names the one pubkey allowed to remove and restore notes.
func (dm *DMMonitor) WithAdmin(pubkey string) *DMMonitor {
	dm.adminPubkey = pubkey
	return dm
}

// Start begins monitoring for DMs
func (dm *DMMonitor) Start(ctx context.Context) error {
	log.Printf("Starting DM monitor on %d relays", len(dm.relays))

	// Subscribe to DMs (kind 4) sent to our relay pubkey.
	//
	// Since matters more here than anywhere else in the relay. Without it the
	// Limit below means "the last hundred DMs ever", and every one of them gets
	// answered with a freshly minted Lightning invoice. On the first Fly deploy
	// that re-invoiced PROMOTE requests from six months earlier, because a new
	// volume starts with processed_dms empty and dedup had nothing to work with.
	since := nostr.Timestamp(resumePoint(dm.storage.DMWatermark(), time.Now(), maxDMBacklog))
	// Gift wraps carry a deliberately backdated timestamp, up to two days, so
	// that when a message was sent cannot be read off a relay. A Since built for
	// kind:4 would therefore filter out a message sent a minute ago. The window
	// is widened for them and the real age is checked after unwrapping, where
	// the rumor inside carries the honest timestamp.
	wrapSince := since - nostr.Timestamp(giftWrapMaxBackdate.Seconds())
	filters := []nostr.Filter{
		{
			Kinds: []int{4}, // Legacy encrypted DMs
			Tags: nostr.TagMap{
				"p": []string{dm.relayPubkey}, // DMs to our relay
			},
			Since: &since,
			Limit: 100,
		},
		{
			Kinds: []int{kindGiftWrap}, // NIP-17, which is what current clients send
			Tags: nostr.TagMap{
				"p": []string{dm.relayPubkey},
			},
			Since: &wrapSince,
			Limit: 200,
		},
	}
	log.Printf("DM monitor resuming from %s", time.Unix(int64(since), 0).Format(time.RFC3339))

	// Connect to relays and subscribe
	pool := nostr.NewSimplePool(ctx)

	// Subscribe to events
	sub := pool.SubMany(ctx, dm.relays, filters)

	go func() {
		for event := range sub {
			// Check if already processed using persistent storage
			if dm.storage.IsDMProcessed(event.ID) {
				continue // Already processed
			}

			log.Printf("Received DM from %s (event ID: %s)", event.PubKey, event.ID)

			// Process the DM
			if err := dm.processDM(ctx, event.Event); err != nil {
				log.Printf("Failed to process DM: %v", err)
				continue
			}

			// Mark as processed in persistent storage
			if err := dm.storage.MarkDMProcessed(event.ID); err != nil {
				log.Printf("Failed to mark DM as processed: %v", err)
			}
			// And move the watermark, so a fresh volume does not start over.
			if err := dm.storage.AdvanceDMWatermark(int64(event.CreatedAt)); err != nil {
				log.Printf("Failed to advance DM watermark: %v", err)
			}
		}
	}()

	if dm.adminPubkey != "" {
		log.Printf("DM monitor started, listening for PROMOTE (admin: %s)", short(dm.adminPubkey, 8))
	} else {
		log.Printf("DM monitor started, listening for PROMOTE; no admin pubkey, so REMOVE is refused")
	}
	return nil
}

// processDM opens a message on whichever transport it arrived by and acts on
// what is inside.
//
// Two transports, because clients moved. kind:4 is the legacy NIP-04 DM, still
// what a few clients send; kind:1059 is NIP-17, which is what the rest send and
// which this relay was deaf to, so a PROMOTE from a current client vanished
// without a trace.
func (dm *DMMonitor) processDM(ctx context.Context, event *nostr.Event) error {
	var sender, text string
	wrapped := event.Kind == kindGiftWrap

	if wrapped {
		rumor, err := unwrapGiftWrap(event, dm.relayPrivkey)
		if err != nil {
			return fmt.Errorf("failed to open gift wrap %s: %w", short(event.ID, 8), err)
		}
		if rumor.Kind != kindChatMessage {
			log.Printf("Gift wrap %s held kind %d, ignoring", short(event.ID, 8), rumor.Kind)
			return nil
		}

		// The wrap's own timestamp is dithered, so the honest age is in here.
		// Without this check a restart would answer two days of stale requests
		// with freshly minted invoices, which is exactly how the first deploy
		// re-invoiced six month old PROMOTEs.
		cutoff := resumePoint(dm.storage.DMWatermark(), time.Now(), maxDMBacklog)
		if int64(rumor.CreatedAt) < cutoff {
			log.Printf("Ignoring a message from %s, sent before the resume point",
				time.Unix(int64(rumor.CreatedAt), 0).Format(time.RFC3339))
			return nil
		}

		sender, text = rumor.PubKey, rumor.Content
	} else {
		sharedSecret, err := nip04.ComputeSharedSecret(event.PubKey, dm.relayPrivkey)
		if err != nil {
			return fmt.Errorf("failed to compute shared secret: %w", err)
		}
		decrypted, err := nip04.Decrypt(event.Content, sharedSecret)
		if err != nil {
			return fmt.Errorf("failed to decrypt DM: %w", err)
		}
		sender, text = event.PubKey, decrypted
	}

	return dm.handleCommand(ctx, sender, strings.TrimSpace(text), wrapped)
}

// handleCommand acts on the text of a message. Anything unrecognised is
// ignored rather than answered: replying to every stray DM would make the relay
// a way to send mail to strangers.
func (dm *DMMonitor) handleCommand(ctx context.Context, sender, text string, wrapped bool) error {
	verb := strings.ToUpper(firstWord(text))

	switch verb {
	case "REMOVE", "RESTORE":
		return dm.handleAdminCommand(ctx, sender, verb, text, wrapped)

	case "PROMOTE":
		postID, amountSats, ok := ParsePromoteCommand(text)
		if !ok {
			log.Printf("Not a valid PROMOTE command, ignoring")
			return nil
		}

		amount := amountSats
		if amount == 0 {
			amount = dm.invoiceManager.defaultAmountSats
		}

		log.Printf("PROMOTE request from %s for post %s (amount: %d sats)",
			short(sender, 8), short(postID, 8), amount)

		invoice, err := dm.invoiceManager.GeneratePromotionInvoice(ctx, postID, amount)
		if err != nil {
			log.Printf("Failed to generate invoice: %v", err)
			return err
		}
		log.Printf("Generated invoice for post %s (payment_hash: %s, amount: %d sats)",
			short(postID, 8), short(invoice.PaymentHash, 12), invoice.AmountSats)

		return dm.reply(ctx, sender, invoiceMessage(invoice), wrapped)

	default:
		log.Printf("Message from %s carried no command I know, ignoring", short(sender, 8))
		return nil
	}
}

// handleAdminCommand takes a note off the board, or puts the possibility back.
//
// The sender is compared against one configured pubkey. That comparison is only
// worth anything because unwrapGiftWrap establishes the sender from the
// signature on the seal rather than from anything the message claims.
func (dm *DMMonitor) handleAdminCommand(ctx context.Context, sender, verb, text string, wrapped bool) error {
	if dm.adminPubkey == "" || sender != dm.adminPubkey {
		// Says nothing about why. Somebody probing for the command learns only
		// that nothing happened.
		log.Printf("Refused %s from %s", verb, short(sender, 8))
		return nil
	}

	fields := strings.Fields(text)
	if len(fields) < 2 {
		return dm.reply(ctx, sender, fmt.Sprintf("%s needs a note reference.", verb), wrapped)
	}

	noteID := normalizeEventID(fields[1])
	if len(noteID) != 64 || !isHex64(noteID) {
		noteID = normalizeEventID(extractEventIDFromText(text))
	}
	if len(noteID) != 64 || !isHex64(noteID) {
		return dm.reply(ctx, sender, "I could not find a note reference in that.", wrapped)
	}

	if verb == "RESTORE" {
		if err := dm.storage.RestorePost(noteID); err != nil {
			return dm.reply(ctx, sender, fmt.Sprintf("Nothing to restore: %v", err), wrapped)
		}
		log.Printf("Admin restored %s by DM", short(noteID, 8))
		return dm.reply(ctx, sender, fmt.Sprintf(
			"Restored %s. It can be promoted again, starting from zero sats.",
			short(noteID, 12)), wrapped)
	}

	sats, err := dm.storage.RemovePost(noteID)
	if err != nil {
		log.Printf("Admin failed to remove %s: %v", short(noteID, 8), err)
		return dm.reply(ctx, sender, "That did not write; the note is still up.", wrapped)
	}

	log.Printf("Admin removed %s by DM (%d sats)", short(noteID, 8), sats)
	return dm.reply(ctx, sender, fmt.Sprintf(
		"Removed %s, which had %d sats against it. Paying for it again will not put it back. "+
			"Nothing is refunded, and the note still exists everywhere else on nostr.",
		short(noteID, 12), sats), wrapped)
}

func firstWord(text string) string {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

func invoiceMessage(invoice *Invoice) string {
	return fmt.Sprintf(`Invoice generated!

Amount: %d sats
Expires: %s

Payment Request:
%s

Pay this invoice to promote your post. Once paid, your post will be added to the relay.`,
		invoice.AmountSats,
		invoice.ExpiresAt.Format("2006-01-02 15:04:05"),
		invoice.PaymentRequest,
	)
}

// reply answers on the transport the request arrived by. Answering a NIP-17
// message with a kind:4 would land somewhere the sender's client is no longer
// looking, which is the whole reason this path was silent.
func (dm *DMMonitor) reply(ctx context.Context, recipientPubkey, message string, wrapped bool) error {
	var event *nostr.Event

	if wrapped {
		wrap, err := wrapMessage(message, recipientPubkey, dm.relayPrivkey)
		if err != nil {
			return fmt.Errorf("failed to wrap the reply: %w", err)
		}
		event = wrap
	} else {
		sharedSecret, err := nip04.ComputeSharedSecret(recipientPubkey, dm.relayPrivkey)
		if err != nil {
			return fmt.Errorf("failed to compute shared secret: %w", err)
		}
		encrypted, err := nip04.Encrypt(message, sharedSecret)
		if err != nil {
			return fmt.Errorf("failed to encrypt reply: %w", err)
		}
		event = &nostr.Event{
			PubKey:    dm.relayPubkey,
			CreatedAt: nostr.Now(),
			Kind:      4,
			Tags:      nostr.Tags{nostr.Tag{"p", recipientPubkey}},
			Content:   encrypted,
		}
		if err := event.Sign(dm.relayPrivkey); err != nil {
			return fmt.Errorf("failed to sign event: %w", err)
		}
	}

	return dm.publish(ctx, event, recipientPubkey)
}

func (dm *DMMonitor) publish(ctx context.Context, event *nostr.Event, recipientPubkey string) error {
	pool := nostr.NewSimplePool(ctx)

	successes := 0
	for _, relayURL := range dm.relays {
		relay, err := pool.EnsureRelay(relayURL)
		if err != nil {
			log.Printf("Failed to connect to relay %s: %v", relayURL, err)
			continue
		}
		if err := relay.Publish(ctx, *event); err != nil {
			log.Printf("Failed to publish reply to %s: %v", relayURL, err)
			continue
		}
		successes++
	}

	if successes == 0 {
		return fmt.Errorf("failed to publish the reply to any relay")
	}

	log.Printf("Reply sent to %s (%d/%d relays)", short(recipientPubkey, 8), successes, len(dm.relays))
	return nil
}
