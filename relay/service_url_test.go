package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/fiatjaf/khatru"
)

func TestRelayServiceURLConcurrentInitialization(t *testing.T) {
	for _, test := range []struct {
		name       string
		configured string
		forwarded  bool
		want       string
	}{
		{name: "direct", want: "http://127.0.0.1:3334"},
		{name: "forwarded", forwarded: true, want: "https://public.example"},
		{name: "configured", configured: "https://configured.example", forwarded: true, want: "https://configured.example"},
	} {
		t.Run(test.name, func(t *testing.T) {
			relay := khatru.NewRelay()
			relay.ServiceURL = test.configured
			// Reading from a handler also checks that initialization finishes
			// before request dispatch, as required by WebSocket authentication.
			relay.Router().HandleFunc("/service-url", func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(relay.ServiceURL))
			})

			start := make(chan struct{})
			var workers sync.WaitGroup
			for i := 0; i < 64; i++ {
				workers.Add(1)
				go func() {
					defer workers.Done()
					request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3334/service-url", nil)
					if test.forwarded {
						request.Header.Set("X-Forwarded-Host", "public.example")
						request.Header.Set("X-Forwarded-Proto", "https")
					}
					response := httptest.NewRecorder()
					<-start
					relay.ServeHTTP(response, request)
					if response.Code != http.StatusOK || response.Body.String() != test.want {
						t.Errorf("response = %d %q, want 200 %q", response.Code, response.Body.String(), test.want)
					}
				}()
			}
			close(start)
			workers.Wait()

			// Later requests must not change the established relay identity.
			request := httptest.NewRequest(http.MethodGet, "https://other.example/service-url", nil)
			response := httptest.NewRecorder()
			relay.ServeHTTP(response, request)
			if response.Body.String() != test.want || relay.ServiceURL != test.want {
				t.Fatalf("later request changed ServiceURL to %q (response %q), want %q", relay.ServiceURL, response.Body.String(), test.want)
			}
		})
	}
}
