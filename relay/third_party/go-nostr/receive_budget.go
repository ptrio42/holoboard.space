package nostr

import (
	"sync"
	"time"
)

// Bound aggregate verification/parsing work across all outbound relay sockets.
var receiveBudget = struct {
	sync.Mutex
	start    time.Time
	messages int
	bytes    int64
}{}

func acceptRelayMessage(size int64) bool {
	receiveBudget.Lock()
	defer receiveBudget.Unlock()
	if time.Since(receiveBudget.start) >= time.Second {
		receiveBudget.start = time.Now()
		receiveBudget.messages = 0
		receiveBudget.bytes = 0
	}
	receiveBudget.messages++
	receiveBudget.bytes += size
	return receiveBudget.messages <= 512 && receiveBudget.bytes <= 16<<20
}
