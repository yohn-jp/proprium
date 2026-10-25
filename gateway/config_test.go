package main

import (
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
		{"wildcard binding", func(c *Config) { c.ListenAddr = ":8080" }},
		{"public interface binding", func(c *Config) { c.ListenAddr = "0.0.0.0:8080" }},
		{"privileged port", func(c *Config) { c.ListenAddr = "127.0.0.1:443" }},
		{"invalid listen address", func(c *Config) { c.ListenAddr = "localhost" }},
		{"invalid oauth client id", func(c *Config) { c.GitHubClientID = "with spaces" }},
		{"out of range timeout", func(c *Config) { c.UpstreamTimeout = 11 * time.Minute }},
		{"relative control socket", func(c *Config) { c.ControlSocket = "run/gateway.sock" }},
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
	for _, key := range []string{"PROPRIUM_LISTEN_ADDR", "PROPRIUM_CONTROL_SOCKET", "PROPRIUM_HOST_ORIGIN", "PROPRIUM_PUBLIC_URL", "GITHUB_CLIENT_ID", "PROPRIUM_UPSTREAM_TIMEOUT"} {
		t.Setenv(key, "")
	}
	if _, err := LoadConfig(); err == nil {
		t.Fatal("missing Host Origin accepted")
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	for _, key := range []string{"PROPRIUM_LISTEN_ADDR", "PROPRIUM_CONTROL_SOCKET", "PROPRIUM_HOST_ORIGIN", "PROPRIUM_PUBLIC_URL", "GITHUB_CLIENT_ID", "PROPRIUM_UPSTREAM_TIMEOUT"} {
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
	if c.ControlSocket != "" {
		t.Fatalf("control socket should be disabled by default, got %q", c.ControlSocket)
	}
}

func TestLoadConfigRejectsBadTimeout(t *testing.T) {
	t.Setenv("PROPRIUM_HOST_ORIGIN", "https://host.example")
	t.Setenv("PROPRIUM_UPSTREAM_TIMEOUT", "fast")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("invalid timeout accepted")
	}
}

func TestObsoleteOwnerKeyCannotEnableIndependentGatewayAuth(t *testing.T) {
    t.Setenv("PROPRIUM_HOST_ORIGIN", "https://host.example")
    t.Setenv("GITHUB_CLIENT_ID", "abcdefghij")
    t.Setenv("PROPRIUM_OWNER_KEY", "a-legacy-value-that-must-not-be-used")
    cfg,err:=LoadConfig()
    if err!=nil {t.Fatal(err)}
    if err:=cfg.Validate();err!=nil {t.Fatal(err)}
}
