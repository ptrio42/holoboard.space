//go:build !race

package main

// raceDetectorEnabled tells the integration tests whether they are running
// under -race.
//
// The tests that stand up an in-process khatru relay have to sit out a race
// build, because khatru v0.7.6 races on its own listener list: addListener
// writes rl.listeners while notifyListeners reads it, with no lock between
// them (listener.go:54 and listener.go:136). Any relay serving one client that
// subscribes while another publishes hits it, so this is worth fixing in the
// relay itself rather than only working around here. Everything in this package
// that does not need khatru still runs under -race.
const raceDetectorEnabled = false
