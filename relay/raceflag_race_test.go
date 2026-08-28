//go:build race

package main

// raceDetectorEnabled tells the integration tests whether they are running
// under -race. See raceflag_norace_test.go for why that matters.
const raceDetectorEnabled = true
