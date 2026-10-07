package nostr

import (
	"fmt"
	"sync"
)

var subscriptionBudget = struct {
	sync.Mutex
	total  int
	relays map[string]int
}{relays: map[string]int{}}

func (sub *Subscription) acquireBudget() error {
	subscriptionBudget.Lock()
	defer subscriptionBudget.Unlock()
	if sub.Context.Err() != nil {
		return sub.Context.Err()
	}
	if sub.budgeted {
		return nil
	}
	if subscriptionBudget.total >= 48 || subscriptionBudget.relays[sub.Relay.URL] >= 8 {
		return fmt.Errorf("outbound subscription budget exhausted")
	}
	sub.budgeted = true
	subscriptionBudget.total++
	subscriptionBudget.relays[sub.Relay.URL]++
	return nil
}

func (sub *Subscription) releaseBudget() {
	subscriptionBudget.Lock()
	defer subscriptionBudget.Unlock()
	if !sub.budgeted {
		return
	}
	sub.budgeted = false
	subscriptionBudget.total--
	subscriptionBudget.relays[sub.Relay.URL]--
	if subscriptionBudget.relays[sub.Relay.URL] == 0 {
		delete(subscriptionBudget.relays, sub.Relay.URL)
	}
}
