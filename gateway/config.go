package main

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultListenAddr      = "127.0.0.1:8080"
	defaultUpstreamTimeout = 2 * time.Minute
)

// Config contains only process configuration. Runtime sessions and request bodies stay in memory.
type Config struct {
	ListenAddr      string
	HostOrigin      string
	PublicURL       string
	GitHubClientID  string
	OwnerKey        string
	UpstreamTimeout time.Duration
}

// LoadConfig validates environment-backed configuration before a listener is opened.
func LoadConfig() (Config, error) {
	cfg := Config{
		ListenAddr:      envOr("PROPRIUM_LISTEN_ADDR", defaultListenAddr),
		HostOrigin:      strings.TrimSpace(os.Getenv("PROPRIUM_HOST_ORIGIN")),
		PublicURL:       strings.TrimSpace(os.Getenv("PROPRIUM_PUBLIC_URL")),
		GitHubClientID:  strings.TrimSpace(os.Getenv("GITHUB_CLIENT_ID")),
		OwnerKey:        os.Getenv("PROPRIUM_OWNER_KEY"),
		UpstreamTimeout: defaultUpstreamTimeout,
	}
	if raw := os.Getenv("PROPRIUM_UPSTREAM_TIMEOUT"); raw != "" {
		duration, err := time.ParseDuration(raw)
		if err != nil || duration < time.Second || duration > 10*time.Minute {
			return Config{}, errors.New("PROPRIUM_UPSTREAM_TIMEOUT must be between 1s and 10m")
		}
		cfg.UpstreamTimeout = duration
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func (c Config) Validate() error {
	_, rawPort, err := net.SplitHostPort(c.ListenAddr)
	if err != nil {
		return fmt.Errorf("PROPRIUM_LISTEN_ADDR must be host:port: %w", err)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil || port < 0 || port > 65535 || port > 0 && port < 1024 {
		return errors.New("PROPRIUM_LISTEN_ADDR must use an unprivileged port (1024-65535), or 0 for an ephemeral port")
	}
	if err := validateOrigin("PROPRIUM_HOST_ORIGIN", c.HostOrigin, true); err != nil {
		return err
	}
	if err := validateOrigin("PROPRIUM_PUBLIC_URL", c.PublicURL, false); err != nil {
		return err
	}
	if !validClientID(c.GitHubClientID) {
		return errors.New("GITHUB_CLIENT_ID must contain 10-128 letters, digits, underscores, or hyphens")
	}
	if c.OwnerKey != "" && len([]byte(c.OwnerKey)) < 32 {
		return errors.New("PROPRIUM_OWNER_KEY must be at least 32 bytes when configured")
	}
	if c.OwnerKey != "" && c.PublicURL == "" {
		return errors.New("PROPRIUM_PUBLIC_URL is required when Live Workspace MCP is enabled")
	}
	if c.UpstreamTimeout < time.Second || c.UpstreamTimeout > 10*time.Minute {
		return errors.New("upstream timeout must be between 1s and 10m")
	}
	return nil
}

func validClientID(s string) bool {
	if len(s) < 10 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func validateOrigin(name, value string, required bool) error {
	if value == "" {
		if required {
			return fmt.Errorf("%s is required", name)
		}
		return nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Opaque != "" {
		return fmt.Errorf("%s must be an exact origin without credentials, path, query, or fragment", name)
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && isLoopbackHost(u.Hostname())) {
		return fmt.Errorf("%s must use HTTPS except for a loopback development origin", name)
	}
	if u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("%s has an invalid port", name)
		}
	}
	if u.String() != value {
		return fmt.Errorf("%s must use canonical origin form", name)
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
