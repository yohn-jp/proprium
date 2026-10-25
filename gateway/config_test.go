package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func testConfig() Config {
	return Config{ListenAddr: "127.0.0.1:8080", HostOrigin: "https://host.example", PublicURL: "https://gateway.example", GitHubClientID: "abcdefghij", UpstreamTimeout: time.Second * 10}
}

func TestConfigValidation(t *testing.T) {
	valid := testConfig()
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	for _, test := range []struct {
		name   string
		change func(*Config)
	}{
		{"missing host origin", func(c *Config) { c.HostOrigin = "" }},
		{"missing oauth client id", func(c *Config) { c.GitHubClientID = "" }},
		{"HTTP public origin", func(c *Config) { c.PublicURL = "http://gateway.example" }},
		{"origin path", func(c *Config) { c.HostOrigin = "https://host.example/path" }},
		{"origin slash", func(c *Config) { c.HostOrigin = "https://host.example/" }},
		{"wildcard without public URL", func(c *Config) { c.ListenAddr = ":8080"; c.PublicURL = "" }},
		{"short owner key", func(c *Config) { c.OwnerKey = strings.Repeat("x", 31) }},
		{"whitespace owner key", func(c *Config) { c.OwnerKey = strings.Repeat("x", 31) + " " }},
		{"public url required for live", func(c *Config) { c.OwnerKey = strings.Repeat("x", 32); c.PublicURL = "" }},
		{"privileged port", func(c *Config) { c.ListenAddr = "127.0.0.1:443" }},
		{"invalid listen address", func(c *Config) { c.ListenAddr = "localhost" }},
		{"invalid oauth client id", func(c *Config) { c.GitHubClientID = "with spaces" }},
		{"out of range timeout", func(c *Config) { c.UpstreamTimeout = 11 * time.Minute }},
	} {
		t.Run(test.name, func(t *testing.T) {
			c := valid
			test.change(&c)
			if err := c.Validate(); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
}

func TestLoadConfigRequiresConfiguredHostOriginAndClientID(t *testing.T) {
	for _, key := range []string{"PROPRIUM_LISTEN_ADDR", "PROPRIUM_HOST_ORIGIN", "PROPRIUM_PUBLIC_URL", "GITHUB_CLIENT_ID", "PROPRIUM_OWNER_KEY", "PROPRIUM_UPSTREAM_TIMEOUT"} {
		t.Setenv(key, "")
	}
	if _, err := LoadConfig(); err == nil {
		t.Fatal("missing Host Origin accepted")
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	for _, key := range []string{"PROPRIUM_LISTEN_ADDR", "PROPRIUM_HOST_ORIGIN", "PROPRIUM_PUBLIC_URL", "GITHUB_CLIENT_ID", "PROPRIUM_OWNER_KEY", "PROPRIUM_UPSTREAM_TIMEOUT"} {
		t.Setenv(key, "")
	}
	t.Setenv("PROPRIUM_HOST_ORIGIN", "https://host.example")
	t.Setenv("GITHUB_CLIENT_ID", "abcdefghij")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != defaultListenAddr || c.UpstreamTimeout != defaultUpstreamTimeout {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestLoadConfigRejectsBadTimeout(t *testing.T) {
	t.Setenv("PROPRIUM_HOST_ORIGIN", "https://host.example")
	t.Setenv("PROPRIUM_UPSTREAM_TIMEOUT", "fast")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("invalid timeout accepted")
	}
}

func TestConfiguredSecretsRemainRuntimeOnly(t *testing.T) {
	key := strings.Repeat("k", 40)
	if err := os.Setenv("PROPRIUM_OWNER_KEY", key); err != nil {
		t.Fatal(err)
	}
	defer os.Unsetenv("PROPRIUM_OWNER_KEY")
	cfg := testConfig()
	cfg.OwnerKey = key
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
