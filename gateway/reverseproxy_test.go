package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	proxyHostOrigin  = "https://host.proprium.test"
	proxyGatewayHost = "gateway.proprium.test"
	proxyOwnerKey    = "0123456789abcdef0123456789abcdef"
)

type dynamicTarget struct{ value atomic.Value }

func (d *dynamicTarget) set(value string) { d.value.Store(value) }
func (d *dynamicTarget) get() string      { return d.value.Load().(string) }

type gatewayProxyFixture struct {
	t          *testing.T
	proxy      *httptest.Server
	client     *http.Client
	target     *dynamicTarget
	gateway    *Server
	httpServer *http.Server
	listener   net.Listener
}

func newGatewayProxyFixture(t *testing.T) *gatewayProxyFixture {
	t.Helper()
	f := &gatewayProxyFixture{t: t, target: &dynamicTarget{}}
	f.startGateway()
	proxy := &httputil.ReverseProxy{
		ErrorLog: log.New(io.Discard, "", 0),
		Rewrite: func(request *httputil.ProxyRequest) {
			target, err := url.Parse(f.target.get())
			if err != nil {
				t.Errorf("parse reverse proxy target: %v", err)
				return
			}
			request.SetURL(target)
			// Cloudflare Tunnel preserves the public request Host for the origin.
			request.Out.Host = request.In.Host
		},
		FlushInterval: -1,
	}
	f.proxy = httptest.NewTLSServer(proxy)
	f.client = f.proxy.Client() // Trust only this test proxy's generated TLS certificate.
	t.Cleanup(func() {
		if f.gateway != nil {
			f.gateway.Close()
		}
		if f.httpServer != nil {
			_ = f.httpServer.Close()
		}
		if f.proxy != nil {
			f.proxy.Close()
		}
	})
	return f
}

func (f *gatewayProxyFixture) startGateway() {
	f.t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		f.t.Fatal(err)
	}
	config := testConfig()
	config.HostOrigin = proxyHostOrigin
	config.PublicURL = "https://" + proxyGatewayHost
	config.OwnerKey = proxyOwnerKey
	config.ListenAddr = listener.Addr().String()
	gateway, err := NewServer(config)
	if err != nil {
		f.t.Fatal(err)
	}
	httpServer := &http.Server{
		Handler:           gateway.Handler(),
		ReadTimeout:       config.UpstreamTimeout,
		ReadHeaderTimeout: time.Second,
		IdleTimeout:       time.Second,
	}
	f.listener, f.gateway, f.httpServer = listener, gateway, httpServer
	f.target.set("http://" + listener.Addr().String())
	go func() { _ = httpServer.Serve(listener) }()
}

func (f *gatewayProxyFixture) request(method, path, token string, body any, hostOrigin bool) (*http.Response, []byte) {
	f.t.Helper()
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
		payload = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, f.proxy.URL+path, payload)
	if err != nil {
		f.t.Fatal(err)
	}
	request.Host = proxyGatewayHost
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if hostOrigin {
		request.Header.Set("Origin", proxyHostOrigin)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if method == http.MethodPost && path == "/mcp" {
		request.Header.Set("Accept", "application/json, text/event-stream")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("MCP-Protocol-Version", currentMCPVersion)
		var value map[string]any
		data, _ := json.Marshal(body)
		_ = json.Unmarshal(data, &value)
		request.Header.Set("Mcp-Method", value["method"].(string))
		params, _ := value["params"].(map[string]any)
		if name, ok := params["name"].(string); ok {
			request.Header.Set("Mcp-Name", name)
		}
	}
	response, err := f.client.Do(request)
	if err != nil {
		f.t.Fatalf("reverse proxy %s %s: %v", method, path, err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		f.t.Fatalf("read reverse proxy response: %v", err)
	}
	return response, data
}

func (f *gatewayProxyFixture) createWorkspace(workspaceID string) (sessionID, ownerToken, clientID, clientToken string) {
	f.t.Helper()
	response, body := f.request(http.MethodPost, "/live/sessions", proxyOwnerKey, map[string]any{
		"workspaceId": workspaceID, "generation": "generation-one", "capabilities": []string{"workspace_info"},
	}, true)
	if response.StatusCode != http.StatusCreated {
		f.t.Fatalf("create live session through proxy: %d %s", response.StatusCode, body)
	}
	var session map[string]string
	if err := json.Unmarshal(body, &session); err != nil {
		f.t.Fatal(err)
	}
	response, body = f.request(http.MethodPost, "/live/sessions/"+session["sessionId"]+"/clients", session["ownerToken"], map[string]any{
		"name": "ReverseProxy Test Client", "capabilities": []string{"workspace_info"},
	}, true)
	if response.StatusCode != http.StatusCreated {
		f.t.Fatalf("pair client through proxy: %d %s", response.StatusCode, body)
	}
	var client map[string]string
	if err := json.Unmarshal(body, &client); err != nil {
		f.t.Fatal(err)
	}
	return session["sessionId"], session["ownerToken"], client["clientId"], client["token"]
}

func (f *gatewayProxyFixture) openWorkspaceStream(sessionID, ownerToken string) (*http.Response, *bufio.Reader, context.CancelFunc) {
	f.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.proxy.URL+"/live/sessions/"+sessionID+"/events", nil)
	if err != nil {
		cancel()
		f.t.Fatal(err)
	}
	request.Host = proxyGatewayHost
	request.Header.Set("Origin", proxyHostOrigin)
	request.Header.Set("Authorization", "Bearer "+ownerToken)
	response, err := f.client.Do(request)
	if err != nil {
		cancel()
		f.t.Fatalf("open SSE over HTTPS reverse proxy: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		cancel()
		f.t.Fatalf("SSE status via proxy %d: %s", response.StatusCode, body)
	}
	reader := bufio.NewReader(response.Body)
	if event := readProxySSEEvent(f.t, reader); event["event"] != "ready" {
		cancel()
		f.t.Fatalf("missing ready SSE over proxy: %#v", event)
	}
	return response, reader, func() { cancel(); _ = response.Body.Close() }
}

func readProxySSEEvent(t *testing.T, reader *bufio.Reader) map[string]string {
	t.Helper()
	values := make(map[string]string)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read proxied SSE event: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			return values
		}
		key, value, ok := strings.Cut(line, ":")
		if ok {
			values[key] = strings.TrimPrefix(value, " ")
		}
	}
}

type proxiedToolResult struct {
	status int
	body   []byte
}

func (f *gatewayProxyFixture) startToolCall(clientToken string, rpcID int) <-chan proxiedToolResult {
	f.t.Helper()
	done := make(chan proxiedToolResult, 1)
	go func() {
		params := map[string]any{
			"name": "workspace_info", "arguments": map[string]any{},
			"_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion},
		}
		requestBody := map[string]any{"jsonrpc": "2.0", "id": rpcID, "method": "tools/call", "params": params}
		response, body := f.request(http.MethodPost, "/mcp", clientToken, requestBody, false)
		done <- proxiedToolResult{response.StatusCode, body}
	}()
	return done
}

func TestGatewayLiveMCPRoundTripThroughTunnelLikeHTTPSReverseProxy(t *testing.T) {
	f := newGatewayProxyFixture(t)
	sessionID, ownerToken, _, clientToken := f.createWorkspace("proxy-workspace")
	stream, reader, closeStream := f.openWorkspaceStream(sessionID, ownerToken)
	defer closeStream()
	_ = stream

	done := f.startToolCall(clientToken, 17)
	event := readProxySSEEvent(t, reader)
	if event["event"] != "request" {
		t.Fatalf("expected request event through HTTPS proxy, got %#v", event)
	}
	var call struct {
		RequestID   string `json:"requestId"`
		WorkspaceID string `json:"workspaceId"`
		Generation  string `json:"generation"`
		Tool        string `json:"tool"`
	}
	if err := json.Unmarshal([]byte(event["data"]), &call); err != nil {
		t.Fatal(err)
	}
	if call.RequestID == "" || call.WorkspaceID != "proxy-workspace" || call.Generation != "generation-one" || call.Tool != "workspace_info" {
		t.Fatalf("incorrect MCP-to-browser SSE request: %#v", call)
	}

	response, body := f.request(http.MethodPost, "/live/sessions/"+sessionID+"/responses", ownerToken, map[string]any{
		"requestId": call.RequestID, "workspaceId": call.WorkspaceID, "generation": call.Generation,
		"status": "completed", "result": map[string]any{"workspaceId": "proxy-workspace", "head": "abc123"},
	}, true)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("Browser response through HTTPS proxy: %d %s", response.StatusCode, body)
	}
	result := <-done
	if result.status != http.StatusOK {
		t.Fatalf("MCP response through HTTPS proxy: %d %s", result.status, result.body)
	}
	var envelope struct {
		Result struct {
			StructuredContent map[string]any `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(result.body, &envelope); err != nil {
		t.Fatal(err)
	}
	data, ok := envelope.Result.StructuredContent["data"].(map[string]any)
	if !ok || data["workspaceId"] != "proxy-workspace" || data["head"] != "abc123" {
		t.Fatalf("MCP result did not reach client through proxy: %s", result.body)
	}
}

func TestTwoWorkspacesStayIsolatedThroughReverseProxy(t *testing.T) {
	f := newGatewayProxyFixture(t)
	sessionA, ownerA, _, clientA := f.createWorkspace("workspace-A")
	sessionB, ownerB, _, clientB := f.createWorkspace("workspace-B")
	streamA, readerA, closeA := f.openWorkspaceStream(sessionA, ownerA)
	defer closeA()
	streamB, readerB, closeB := f.openWorkspaceStream(sessionB, ownerB)
	defer closeB()
	_ = streamA
	_ = streamB

	doneA := f.startToolCall(clientA, 21)
	doneB := f.startToolCall(clientB, 22)
	eventA := readProxySSEEvent(t, readerA)
	eventB := readProxySSEEvent(t, readerB)
	var requestA, requestB map[string]any
	if err := json.Unmarshal([]byte(eventA["data"]), &requestA); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(eventB["data"]), &requestB); err != nil {
		t.Fatal(err)
	}
	if eventA["event"] != "request" || eventB["event"] != "request" || requestA["workspaceId"] != "workspace-A" || requestB["workspaceId"] != "workspace-B" || requestA["requestId"] == requestB["requestId"] {
		t.Fatalf("workspace events crossed: A=%#v B=%#v", requestA, requestB)
	}

	crossOwner, crossOwnerBody := f.request(http.MethodPost, "/live/sessions/"+sessionB+"/responses", ownerA, map[string]any{
		"requestId": requestA["requestId"], "workspaceId": "workspace-A", "generation": "generation-one",
		"status": "completed", "result": map[string]any{"private": true},
	}, true)
	if crossOwner.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cross-session owner token status %d: %s", crossOwner.StatusCode, crossOwnerBody)
	}
	cross, crossBody := f.request(http.MethodPost, "/live/sessions/"+sessionB+"/responses", ownerB, map[string]any{
		"requestId": requestA["requestId"], "workspaceId": "workspace-A", "generation": "generation-one",
		"status": "completed", "result": map[string]any{"private": true},
	}, true)
	if cross.StatusCode == http.StatusAccepted {
		t.Fatalf("cross-session response accepted: %s", crossBody)
	}
	for _, side := range []struct {
		session, owner string
		call           map[string]any
		value          string
	}{{sessionA, ownerA, requestA, "result-A"}, {sessionB, ownerB, requestB, "result-B"}} {
		response, body := f.request(http.MethodPost, "/live/sessions/"+side.session+"/responses", side.owner, map[string]any{
			"requestId": side.call["requestId"], "workspaceId": side.call["workspaceId"], "generation": side.call["generation"],
			"status": "completed", "result": map[string]string{"value": side.value},
		}, true)
		if response.StatusCode != http.StatusAccepted {
			t.Fatalf("respond workspace %s: %d %s", side.value, response.StatusCode, body)
		}
	}
	for _, side := range []struct {
		done     <-chan proxiedToolResult
		expected string
	}{{doneA, "result-A"}, {doneB, "result-B"}} {
		result := <-side.done
		var envelope struct {
			Result struct {
				StructuredContent map[string]any `json:"structuredContent"`
			} `json:"result"`
		}
		if result.status != http.StatusOK || json.Unmarshal(result.body, &envelope) != nil {
			t.Fatalf("workspace result failed: %d %s", result.status, result.body)
		}
		data, ok := envelope.Result.StructuredContent["data"].(map[string]any)
		if !ok || data["value"] != side.expected {
			t.Fatalf("wrong workspace result: expected %s, got %s", side.expected, result.body)
		}
	}
}

func TestGatewayRestartThroughReverseProxyInvalidatesPendingAndOldTokens(t *testing.T) {
	f := newGatewayProxyFixture(t)
	sessionID, ownerToken, _, clientToken := f.createWorkspace("restart-workspace")
	stream, reader, closeStream := f.openWorkspaceStream(sessionID, ownerToken)
	defer closeStream()
	_ = stream
	done := f.startToolCall(clientToken, 31)
	event := readProxySSEEvent(t, reader)
	var call map[string]any
	if err := json.Unmarshal([]byte(event["data"]), &call); err != nil {
		t.Fatal(err)
	}

	f.gateway.Close()
	select {
	case result := <-done:
		if result.status != http.StatusServiceUnavailable {
			t.Fatalf("disconnect returned %d instead of unavailable: %s", result.status, result.body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending MCP call did not wake on Gateway shutdown")
	}
	stale, staleBody := f.request(http.MethodPost, "/live/sessions/"+sessionID+"/responses", ownerToken, map[string]any{
		"requestId": call["requestId"], "workspaceId": "restart-workspace", "generation": "generation-one",
		"status": "completed", "result": map[string]any{"late": true},
	}, true)
	if stale.StatusCode == http.StatusAccepted {
		t.Fatalf("stale Browser response accepted after shutdown: %s", staleBody)
	}

	_ = f.httpServer.Close()
	f.startGateway()
	response, body := f.request(http.MethodPost, "/mcp", clientToken, map[string]any{
		"jsonrpc": "2.0", "id": 32, "method": "tools/list", "params": map[string]any{"_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}},
	}, false)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Gateway restart retained old pairing token: %d %s", response.StatusCode, body)
	}

	newSessionID, newOwnerToken, _, newClientToken := f.createWorkspace("restart-workspace")
	if newSessionID == sessionID {
		t.Fatal("restart reused the old session id")
	}
	newStream, newReader, newCloseStream := f.openWorkspaceStream(newSessionID, newOwnerToken)
	defer newCloseStream()
	_ = newStream
	newDone := f.startToolCall(newClientToken, 33)
	newEvent := readProxySSEEvent(t, newReader)
	var newCall map[string]any
	if err := json.Unmarshal([]byte(newEvent["data"]), &newCall); err != nil {
		t.Fatal(err)
	}
	response, body = f.request(http.MethodPost, "/live/sessions/"+newSessionID+"/responses", newOwnerToken, map[string]any{
		"requestId": newCall["requestId"], "workspaceId": newCall["workspaceId"], "generation": newCall["generation"],
		"status": "completed", "result": map[string]string{"reconnected": "true"},
	}, true)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("new session response: %d %s", response.StatusCode, body)
	}
	result := <-newDone
	if result.status != http.StatusOK {
		t.Fatalf("fresh pairing after restart failed: %d %s", result.status, result.body)
	}
}
