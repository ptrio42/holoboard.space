package main

import (
	"fmt"
	"os"
	"strconv"
)

func curatorConfigFromEnv(pubkey string, readRelays []string) (CuratorConfig, error) {
	config := DefaultCuratorConfig()
	config.Token, config.IdentityPubkey = os.Getenv("CURATOR_TOKEN"), pubkey
	config.ReviewToken = os.Getenv("CURATOR_REVIEW_TOKEN")
	if config.ReviewToken != "" && (len(config.ReviewToken) < 32 || config.ReviewToken == config.Token || config.ReviewToken == os.Getenv("ADMIN_TOKEN")) {
		return config, fmt.Errorf("CURATOR_REVIEW_TOKEN must contain at least 32 characters and differ from agent and admin tokens")
	}
	if value := getEnv("CURATOR_REVIEW_REQUIRED", "true"); value == "true" {
		config.ReviewRequired = true
	} else if value == "false" {
		config.ReviewRequired = false
	} else {
		return config, fmt.Errorf("CURATOR_REVIEW_REQUIRED must be true or false")
	}
	config.Mode = getEnv("CURATOR_MODE", curatorDisabled)
	if config.Mode != curatorDisabled && config.Mode != curatorDryRun && config.Mode != curatorActive {
		return config, fmt.Errorf("CURATOR_MODE must be disabled, dry_run or active")
	}
	if config.Mode != curatorDisabled && (len(config.Token) < 32 || config.Token == os.Getenv("ADMIN_TOKEN")) {
		return config, fmt.Errorf("CURATOR_TOKEN must contain at least 32 characters and differ from ADMIN_TOKEN")
	}
	config.Relays = readRelays
	if value := os.Getenv("CURATOR_RELAYS"); value != "" {
		config.Relays = splitAndTrim(value)
		// Only explicit operator configuration receives trusted URL handling.
		trustConfiguredRelays(config.Relays)
	}
	budget, err := strconv.ParseInt(getEnv("CURATOR_DAILY_REWARD_SATS", "1000"), 10, 64)
	if err != nil || budget < 21 || budget > 1000 {
		return config, fmt.Errorf("CURATOR_DAILY_REWARD_SATS must be between 21 and 1000")
	}
	count, err := strconv.Atoi(getEnv("CURATOR_DAILY_DISCOVERIES", "3"))
	if err != nil || count < 1 || count > 3 {
		return config, fmt.Errorf("CURATOR_DAILY_DISCOVERIES must be between 1 and 3")
	}
	config.DailyRewardSats, config.DailyDiscoveries = budget, count
	return config, nil
}
