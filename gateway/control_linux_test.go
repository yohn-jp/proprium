//go:build linux

package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type gateBody struct {
	started chan struct{}
	resume  chan struct{}
	once    bool
	reader  *strings.Reader
}

func (b *gateBody) Read(p []byte) (int, error) {
	if !b.once {
		b.once = true
		close(b.started)
		<-b.resume
		b.reader = strings.NewReader(`{"workspaceId":"workspace","generation":"generation","capabilities":[]}`)
	}
	return b.reader.Read(p)
}

func (b *gateBody) Close() error { return nil }

func controlTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	cfg := testConfig()
	cfg.OwnerKey = testOwnerKey
	cfg.ControlSocket = filepath.Join(t.TempDir(), "gateway.sock")
	s, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.startControlSocket(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		s.shutdownControl(ctx)
	})
	return s, cfg.ControlSocket
}

func controlRequest(t *testing.T, socket, method, path string, headers http.Header) (*http.Response, []byte) {
	t.Helper()
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	client := &http.Client{Transport: transport, Timeout: time.Second}
	t.Cleanup(transport.CloseIdleConnections)
	req, err := http.NewRequest(method, "http://localhost"+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers.Clone()
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return response, body
}

func createControlTestSession(t *testing.T, s *Server) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "https://gateway.example/live/sessions", strings.NewReader(`{"workspaceId":"workspace","generation":"generation","capabilities":[]}`))
	req.Host = "gateway.example"
	req.Header.Set("Origin", s.config.HostOrigin)
	req.Header.Set("Authorization", "Bearer "+testOwnerKey)
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, req)
	return response
}

func TestControlSocketPermissionsStaleSafetyAndPrivateRoute(t *testing.T) {
	s, socket := controlTestServer(t)
	info, err := os.Stat(socket)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("control socket permissions are %o, want 600", info.Mode().Perm())
	}
	duplicate, err := NewServer(s.config)
	if err != nil {
		t.Fatal(err)
	}
	if err := duplicate.startControlSocket(); err == nil {
		t.Fatal("second listener accepted an active control socket")
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatalf("active socket was removed: %v", err)
	}
	response, body := controlRequest(t, socket, http.MethodGet, "/status", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status returned %d: %s", response.StatusCode, body)
	}
	var status controlSnapshot
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatal(err)
	}
	if status != (controlSnapshot{}) {
		t.Fatalf("unexpected idle status: %+v", status)
	}
	for _, forbidden := range []string{"sessionId", "ownerToken", "workspace"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("status disclosed %q: %s", forbidden, body)
		}
	}
	public := httptest.NewRequest(http.MethodGet, "https://gateway.example/status", nil)
	public.Host = "gateway.example"
	publicResponse := httptest.NewRecorder()
	s.Handler().ServeHTTP(publicResponse, public)
	if publicResponse.Code != http.StatusNotFound {
		t.Fatalf("status leaked onto public mux: %d", publicResponse.Code)
	}
}

func TestControlQuiesceRefusesActiveWorkAndGatesNewSessions(t *testing.T) {
	s, socket := controlTestServer(t)
	created := createControlTestSession(t, s)
	if created.Code != http.StatusCreated {
		t.Fatalf("session create returned %d: %s", created.Code, created.Body.String())
	}
	response, _ := controlRequest(t, socket, http.MethodPost, "/quiesce", nil)
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("quiesce with active session returned %d, want 409", response.StatusCode)
	}
	if s.controlRegistry().controlSnapshot().Quiescing {
		t.Fatal("refused quiesce changed quiescing state")
	}
	headers := make(http.Header)
	headers.Set("X-Proprium-Maintenance", "true")
	response, body := controlRequest(t, socket, http.MethodPost, "/quiesce", headers)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("maintenance quiesce returned %d: %s", response.StatusCode, body)
	}
	if next := createControlTestSession(t, s); next.Code != http.StatusServiceUnavailable {
		t.Fatalf("new session during quiesce returned %d", next.Code)
	}
	response, _ = controlRequest(t, socket, http.MethodDelete, "/quiesce", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("resume returned %d", response.StatusCode)
	}
	if next := createControlTestSession(t, s); next.Code != http.StatusCreated {
		t.Fatalf("new session after resume returned %d", next.Code)
	}
}

func TestControlQuiesceIdleBlocksThenResumeAllowsSession(t *testing.T) {
	s, socket := controlTestServer(t)
	response, _ := controlRequest(t, socket, http.MethodPost, "/quiesce", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("idle quiesce returned %d", response.StatusCode)
	}
	if created := createControlTestSession(t, s); created.Code != http.StatusServiceUnavailable {
		t.Fatalf("session during idle quiesce returned %d", created.Code)
	}
	response, _ = controlRequest(t, socket, http.MethodDelete, "/quiesce", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("resume returned %d", response.StatusCode)
	}
	if created := createControlTestSession(t, s); created.Code != http.StatusCreated {
		t.Fatalf("session after resume returned %d", created.Code)
	}
}

func TestControlQuiesceCountsSessionRegistrationBeforeBodyCompletes(t *testing.T) {
	s, socket := controlTestServer(t)
	body := &gateBody{started: make(chan struct{}), resume: make(chan struct{})}
	req := httptest.NewRequest(http.MethodPost, "https://gateway.example/live/sessions", body)
	req.Host = "gateway.example"
	req.Header.Set("Origin", s.config.HostOrigin)
	req.Header.Set("Authorization", "Bearer "+testOwnerKey)
	req.Header.Set("Content-Type", "application/json")
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, req)
		done <- response
	}()
	select {
	case <-body.started:
	case <-time.After(time.Second):
		t.Fatal("session registration did not begin reading its body")
	}
	response, statusBody := controlRequest(t, socket, http.MethodGet, "/status", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status returned %d", response.StatusCode)
	}
	var status controlSnapshot
	if err := json.Unmarshal(statusBody, &status); err != nil {
		t.Fatal(err)
	}
	if status.Pending != 1 || status.Sessions != 0 {
		t.Fatalf("in-flight registration not reflected in status: %+v", status)
	}
	response, _ = controlRequest(t, socket, http.MethodPost, "/quiesce", nil)
	if response.StatusCode != http.StatusConflict || s.controlRegistry().controlSnapshot().Quiescing {
		t.Fatalf("quiesce did not refuse pending registration: status=%d", response.StatusCode)
	}
	close(body.resume)
	select {
	case created := <-done:
		if created.Code != http.StatusCreated {
			t.Fatalf("session create returned %d: %s", created.Code, created.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("session registration did not finish")
	}
}
