package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testOwnerKey = "0123456789abcdef0123456789abcdef"
const testHostOrigin = "https://host.proprium.test"

type liveFixture struct {
	t                                                                     *testing.T
	registry                                                              *LiveRegistry
	server                                                                *httptest.Server
	workspaceID, generation, sessionID, ownerToken, clientID, clientToken string
	cancelStream                                                          context.CancelFunc
	stream                                                                *bufio.Reader
}

func newLiveFixture(t *testing.T, capabilities, clientCapabilities []string) *liveFixture {
	t.Helper()
	r := NewLiveRegistry(LiveConfig{OwnerKey: testOwnerKey, HostOrigin: testHostOrigin, ListenAddr: "127.0.0.1:8080"})
	mux := http.NewServeMux()
	mux.HandleFunc("/live/sessions", r.ServeHTTP)
	mux.HandleFunc("/live/sessions/", r.ServeHTTP)
	mux.Handle("/mcp", r.MCPHandler())
	srv := httptest.NewServer(mux)
	t.Cleanup(func() { r.Close(); srv.Close() })
	r.config.PublicURL = srv.URL
	f := &liveFixture{t: t, registry: r, server: srv, workspaceID: "workspace-123", generation: "generation-4"}
	created := f.ownerJSON(http.MethodPost, "/live/sessions", testOwnerKey, map[string]any{"workspaceId": f.workspaceID, "generation": f.generation, "capabilities": capabilities})
	if created.Code != http.StatusCreated {
		t.Fatalf("create session: %d %s", created.Code, created.Body.String())
	}
	var session map[string]string
	if err := json.Unmarshal(created.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	f.sessionID = session["sessionId"]
	f.ownerToken = session["ownerToken"]
	client := f.ownerJSON(http.MethodPost, "/live/sessions/"+f.sessionID+"/clients", f.ownerToken, map[string]any{"name": "test client", "capabilities": clientCapabilities})
	if client.Code != http.StatusCreated {
		t.Fatalf("create client: %d %s", client.Code, client.Body.String())
	}
	var auth map[string]string
	if err := json.Unmarshal(client.Body.Bytes(), &auth); err != nil {
		t.Fatal(err)
	}
	f.clientID = auth["clientId"]
	f.clientToken = auth["token"]
	return f
}

func (f *liveFixture) ownerJSON(method, path, token string, payload any) *httptest.ResponseRecorder {
	f.t.Helper()
	data, _ := json.Marshal(payload)
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	req.Host = strings.TrimPrefix(strings.TrimPrefix(f.server.URL, "http://"), "https://")
	req.Header.Set("Origin", testHostOrigin)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.registry.ServeHTTP(rec, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != testHostOrigin || rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		f.t.Fatalf("live response did not allow credentialed Host origin: %d %#v", rec.Code, rec.Header())
	}
	return rec
}

func (f *liveFixture) openEvents() {
	f.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+"/live/sessions/"+f.sessionID+"/events", nil)
	if err != nil {
		f.t.Fatal(err)
	}
	req.Header.Set("Origin", testHostOrigin)
	req.Header.Set("Authorization", "Bearer "+f.ownerToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		f.t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		cancel()
		f.t.Fatalf("events: %d %s", resp.StatusCode, body)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != testHostOrigin || resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
		cancel()
		_ = resp.Body.Close()
		f.t.Fatalf("SSE response did not allow credentialed Host origin: %#v", resp.Header)
	}
	f.cancelStream = func() { cancel(); _ = resp.Body.Close() }
	f.stream = bufio.NewReader(resp.Body)
	event := f.readEvent()
	if event["event"] != "ready" {
		f.t.Fatalf("expected ready event, got %#v", event)
	}
	var ready map[string]string
	_ = json.Unmarshal([]byte(event["data"]), &ready)
	if ready["workspaceId"] != f.workspaceID || ready["generation"] != f.generation {
		f.t.Fatalf("wrong ready binding: %#v", ready)
	}
}

func (f *liveFixture) readEvent() map[string]string {
	f.t.Helper()
	out := map[string]string{}
	for {
		line, err := f.stream.ReadString('\n')
		if err != nil {
			f.t.Fatalf("read SSE: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			return out
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		out[key] = strings.TrimPrefix(value, " ")
	}
}

func currentMCPRequest(method string, id int, params any) []byte {
	value := map[string]any{"jsonrpc": "2.0", "method": method, "id": id, "params": params}
	encoded, _ := json.Marshal(value)
	return encoded
}
func (f *liveFixture) mcpRequest(method string, id int, params any, clientToken string, protocol string) (*http.Response, []byte) {
	f.t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.server.URL+"/mcp", bytes.NewReader(currentMCPRequest(method, id, params)))
	if err != nil {
		f.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+clientToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", protocol)
	req.Header.Set("Mcp-Method", method)
	if name, ok := params.(map[string]any)["name"].(string); ok {
		req.Header.Set("Mcp-Name", name)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return resp, body
}

func TestLivePreflightAndRequestBodyLimit(t *testing.T) {
	r := NewLiveRegistry(LiveConfig{OwnerKey: testOwnerKey, HostOrigin: testHostOrigin, PublicURL: "https://gateway.proprium.test", ListenAddr: "127.0.0.1:8080"})
	req := httptest.NewRequest(http.MethodOptions, "/live/sessions", nil)
	req.Host = "gateway.proprium.test"
	req.Header.Set("Origin", testHostOrigin)
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != testHostOrigin || rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("valid preflight failed: %d %#v", rec.Code, rec.Header())
	}
	req = httptest.NewRequest(http.MethodOptions, "/live/sessions", nil)
	req.Host = "gateway.proprium.test"
	req.Header.Set("Origin", testHostOrigin)
	req.Header.Set("Access-Control-Request-Method", "PUT")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("invalid method preflight response: %d %#v", rec.Code, rec.Header())
	}
	body := `{"workspaceId":"` + strings.Repeat("x", maxLiveBodyBytes) + `","generation":"g","capabilities":[]}`
	req = httptest.NewRequest(http.MethodPost, "/live/sessions", strings.NewReader(body))
	req.Host = "gateway.proprium.test"
	req.Header.Set("Origin", testHostOrigin)
	req.Header.Set("Authorization", "Bearer "+testOwnerKey)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge || rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("large body response: %d %#v", rec.Code, rec.Header())
	}
}

func TestLiveEdgeCookieDoesNotReplaceBearerOrExactOrigin(t *testing.T) {
	r := NewLiveRegistry(LiveConfig{OwnerKey: testOwnerKey, HostOrigin: testHostOrigin, PublicURL: "https://gateway.proprium.test", ListenAddr: "127.0.0.1:8080"})
	body := `{"workspaceId":"workspace","generation":"generation","capabilities":[]}`
	req := httptest.NewRequest(http.MethodPost, "/live/sessions", strings.NewReader(body))
	req.Host = "gateway.proprium.test"
	req.Header.Set("Origin", testHostOrigin)
	req.Header.Set("Cookie", "CF_Authorization=edge-only")
	req.Header.Set("Content-Type", "application/json")
	withoutBearer := httptest.NewRecorder()
	r.ServeHTTP(withoutBearer, req)
	if withoutBearer.Code != http.StatusUnauthorized || withoutBearer.Header().Get("Access-Control-Allow-Origin") != testHostOrigin || withoutBearer.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("edge cookie replaced owner bearer or exact-origin CORS: %d %#v", withoutBearer.Code, withoutBearer.Header())
	}

	req = httptest.NewRequest(http.MethodPost, "/live/sessions", strings.NewReader(body))
	req.Host = "gateway.proprium.test"
	req.Header.Set("Origin", "https://attacker.example")
	req.Header.Set("Authorization", "Bearer "+testOwnerKey)
	req.Header.Set("Content-Type", "application/json")
	foreignOrigin := httptest.NewRecorder()
	r.ServeHTTP(foreignOrigin, req)
	if foreignOrigin.Code != http.StatusForbidden || foreignOrigin.Header().Get("Access-Control-Allow-Origin") != "" || foreignOrigin.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("foreign origin received credentialed CORS: %d %#v", foreignOrigin.Code, foreignOrigin.Header())
	}
}
