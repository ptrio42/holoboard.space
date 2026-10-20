package main

import (
	"strings"
	"testing"
)

func TestCuratorEnvironmentDefaultsAndRejectsUnsafeConfiguration(t *testing.T) {
	for _, key := range []string{"CURATOR_MODE", "CURATOR_TOKEN", "CURATOR_RELAYS", "CURATOR_DAILY_REWARD_SATS", "CURATOR_DAILY_DISCOVERIES", "ADMIN_TOKEN", "CURATOR_REVIEW_TOKEN", "CURATOR_REVIEW_REQUIRED"} {
		t.Setenv(key, "")
	}
	config, err := curatorConfigFromEnv("identity", nil)
	if err != nil || config.Mode != curatorDisabled || config.DailyRewardSats != 1000 || config.DailyDiscoveries != 3 || !config.ReviewRequired {
		t.Fatalf("unexpected defaults: %+v, %v", config, err)
	}
	for _, test := range []struct{ key, value string }{
		{"CURATOR_MODE", "enabled"}, {"CURATOR_MODE", "active"},
		{"CURATOR_DAILY_REWARD_SATS", "0"}, {"CURATOR_DAILY_REWARD_SATS", "1001"},
		{"CURATOR_DAILY_DISCOVERIES", "0"}, {"CURATOR_DAILY_DISCOVERIES", "4"},
		{"CURATOR_REVIEW_REQUIRED", "maybe"}, {"CURATOR_REVIEW_TOKEN", "short"},
	} {
		t.Run(test.key+test.value, func(t *testing.T) {
			t.Setenv(test.key, test.value)
			if _, err := curatorConfigFromEnv("identity", nil); err == nil {
				t.Fatal("invalid configuration did not fail closed")
			}
		})
	}
	t.Setenv("CURATOR_MODE", "dry_run")
	t.Setenv("CURATOR_TOKEN", strings.Repeat("c", 32))
	if _, err := curatorConfigFromEnv("identity", nil); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ADMIN_TOKEN", strings.Repeat("c", 32))
	if _, err := curatorConfigFromEnv("identity", nil); err == nil {
		t.Fatal("curator token reused administrative authority")
	}
	t.Setenv("ADMIN_TOKEN", strings.Repeat("a", 32))
	for _, value := range []string{strings.Repeat("a", 32), strings.Repeat("c", 32)} {
		t.Setenv("CURATOR_REVIEW_TOKEN", value)
		if _, err := curatorConfigFromEnv("identity", nil); err == nil {
			t.Fatal("reviewer credential reused agent or admin authority")
		}
	}
	t.Setenv("CURATOR_REVIEW_TOKEN", strings.Repeat("r", 32))
	t.Setenv("CURATOR_REVIEW_REQUIRED", "false")
	if config, err := curatorConfigFromEnv("identity", nil); err != nil || config.ReviewRequired {
		t.Fatal("explicit initial automatic mode was not accepted")
	}
}
