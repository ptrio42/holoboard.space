package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/fasthttp/websocket"
	"github.com/nbd-wtf/go-nostr"
)

// Exercise the real entry point in a child process so returning from main
// cannot cut off its shutdown goroutine without failing this test.
func TestRelaySIGTERMCompletesShutdown(t *testing.T) {
	if os.Getenv("HOLOBOARD_SHUTDOWN_TEST_CHILD") == "1" {
		discoveryRelays = nil
		main()
		os.Exit(0)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "relay.log")
	output, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestRelaySIGTERMCompletesShutdown$")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"HOLOBOARD_SHUTDOWN_TEST_CHILD=1",
		"LIGHTNING_BACKEND=mock",
		"RELAY_PRIVKEY="+nostr.GeneratePrivateKey(),
		fmt.Sprintf("PORT=%d", port),
		"DATA_FILE="+filepath.Join(dir, "relay_data.json"),
		"FETCH_RELAYS=ws://127.0.0.1:9",
		"DM_RELAYS=ws://127.0.0.1:9",
	)
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	client := http.Client{Timeout: time.Second}
	for {
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/board", port))
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		if ctx.Err() != nil {
			t.Fatal("relay did not become ready before the timeout")
		}
		time.Sleep(25 * time.Millisecond)
	}
	// Connected readers must be closed before the process exits too.
	for i := 0; i < 32; i++ {
		connection, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("ws://127.0.0.1:%d", port), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		logs, readErr := os.ReadFile(logPath)
		if readErr != nil {
			t.Fatalf("relay did not exit cleanly: %v (could not read log: %v)", err, readErr)
		}
		t.Fatalf("relay did not exit cleanly: %v\n%s", err, logs)
	}
	logs, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(logs), "Shutdown complete") {
		t.Fatalf("relay exited before shutdown completed:\n%s", logs)
	}
}
