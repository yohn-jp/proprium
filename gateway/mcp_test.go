package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLiveOwnerAndClientCapabilitiesAreScoped(t *testing.T) {
	f := newLiveFixture(t, []string{"git_status", "file_read", "workspace_info"}, []string{"git_status", "workspace_info"})
	result := f.ownerJSON(http.MethodGet, "/live/sessions/"+f.sessionID+"/clients", f.ownerToken, nil)
	if result.Code != http.StatusOK || bytes.Contains(result.Body.Bytes(), []byte(f.clientToken)) {
		t.Fatalf("client list exposed a token: %d %s", result.Code, result.Body.String())
	}
	response, body := f.mcpRequest("tools/list", 1, map[string]any{"_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}}, f.clientToken, currentMCPVersion)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("tools/list: %d %s", response.StatusCode, body)
	}
	var list struct {
		Result struct {
			Tools []mcpTool `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Result.Tools) != 2 || list.Result.Tools[0].Name != "git_status" || list.Result.Tools[1].Name != "workspace_info" {
		t.Fatalf("wrong client tool scope: %#v", list.Result.Tools)
	}
	response, body = f.mcpRequest("tools/call", 2, map[string]any{"name": "file_read", "arguments": map[string]any{"path": "README.md"}, "_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}}, f.clientToken, currentMCPVersion)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("ungranted tool call status %d: %s", response.StatusCode, body)
	}
	revoked := f.ownerJSON(http.MethodDelete, "/live/sessions/"+f.sessionID+"/clients/"+f.clientID, f.ownerToken, nil)
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke client: %d", revoked.Code)
	}
	response, body = f.mcpRequest("tools/list", 3, map[string]any{"_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}}, f.clientToken, currentMCPVersion)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked token status %d: %s", response.StatusCode, body)
	}
}

func TestLiveMCPToolCallUsesWorkspaceSSEAndValidatesResponseBinding(t *testing.T) {
	f := newLiveFixture(t, []string{"git_status"}, []string{"git_status"})
	f.openEvents()
	defer f.cancelStream()
	done := make(chan struct {
		resp *http.Response
		body []byte
	}, 1)
	go func() {
		params := map[string]any{"name": "git_status", "arguments": map[string]any{}, "_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}}
		resp, body := f.mcpRequest("tools/call", 7, params, f.clientToken, currentMCPVersion)
		done <- struct {
			resp *http.Response
			body []byte
		}{resp, body}
	}()
	event := f.readEvent()
	if event["event"] != "request" {
		t.Fatalf("expected request event, got %#v", event)
	}
	var call map[string]any
	if err := json.Unmarshal([]byte(event["data"]), &call); err != nil {
		t.Fatal(err)
	}
	if call["tool"] != "git_status" || call["workspaceId"] != f.workspaceID || call["generation"] != f.generation {
		t.Fatalf("wrong workspace request: %#v", call)
	}
	requestID, _ := call["requestId"].(string)
	if requestID == "" {
		t.Fatal("missing request id")
	}
	bad := f.ownerJSON(http.MethodPost, "/live/sessions/"+f.sessionID+"/responses", f.ownerToken, map[string]any{"requestId": requestID, "workspaceId": f.workspaceID, "generation": "stale-generation", "status": "completed", "result": map[string]any{"clean": true}})
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("stale generation accepted: %d %s", bad.Code, bad.Body.String())
	}
	good := f.ownerJSON(http.MethodPost, "/live/sessions/"+f.sessionID+"/responses", f.ownerToken, map[string]any{"requestId": requestID, "workspaceId": f.workspaceID, "generation": f.generation, "status": "completed", "result": map[string]any{"clean": true}})
	if good.Code != http.StatusAccepted {
		t.Fatalf("response rejected: %d %s", good.Code, good.Body.String())
	}
	result := <-done
	if result.resp.StatusCode != http.StatusOK {
		t.Fatalf("tools/call: %d %s", result.resp.StatusCode, result.body)
	}
	var mcp struct {
		Result toolResult `json:"result"`
	}
	if err := json.Unmarshal(result.body, &mcp); err != nil {
		t.Fatal(err)
	}
	if mcp.Result.IsError || mcp.Result.StructuredContent["data"].(map[string]any)["clean"] != true {
		t.Fatalf("wrong MCP result: %s", result.body)
	}
	duplicate := f.ownerJSON(http.MethodPost, "/live/sessions/"+f.sessionID+"/responses", f.ownerToken, map[string]any{"requestId": requestID, "workspaceId": f.workspaceID, "generation": f.generation, "status": "completed", "result": map[string]any{"clean": true}})
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate response accepted: %d", duplicate.Code)
	}
}

func TestLiveMCPHTTPCancellationIsForwardedToBrowser(t *testing.T) {
	f := newLiveFixture(t, []string{"workspace_info"}, []string{"workspace_info"})
	f.openEvents()
	defer f.cancelStream()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{}, 1)
	go func() {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, f.server.URL+"/mcp", bytes.NewReader(currentMCPRequest("tools/call", 9, map[string]any{"name": "workspace_info", "arguments": map[string]any{}, "_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}})))
		req.Header.Set("Authorization", "Bearer "+f.clientToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", currentMCPVersion)
		req.Header.Set("Mcp-Method", "tools/call")
		req.Header.Set("Mcp-Name", "workspace_info")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
		done <- struct{}{}
	}()
	event := f.readEvent()
	var call map[string]any
	_ = json.Unmarshal([]byte(event["data"]), &call)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled MCP request did not stop")
	}
	cancelEvent := f.readEvent()
	if cancelEvent["event"] != "cancel" {
		t.Fatalf("expected cancellation event: %#v", cancelEvent)
	}
	var cancellation map[string]string
	_ = json.Unmarshal([]byte(cancelEvent["data"]), &cancellation)
	if cancellation["requestId"] != call["requestId"] || cancellation["reason"] != "cancelled" {
		t.Fatalf("cancellation did not match request: %#v", cancellation)
	}
}

func TestClientRevocationIsReportedSeparatelyFromRequestCancellation(t *testing.T) {
	f := newLiveFixture(t, []string{"workspace_info"}, []string{"workspace_info"})
	f.openEvents()
	defer f.cancelStream()
	done := make(chan struct {
		resp *http.Response
		body []byte
	}, 1)
	go func() {
		params := map[string]any{"name": "workspace_info", "arguments": map[string]any{}, "_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}}
		resp, body := f.mcpRequest("tools/call", 19, params, f.clientToken, currentMCPVersion)
		done <- struct {
			resp *http.Response
			body []byte
		}{resp, body}
	}()
	event := f.readEvent()
	if event["event"] != "request" {
		t.Fatalf("expected pending browser request, got %#v", event)
	}
	var pending map[string]any
	if err := json.Unmarshal([]byte(event["data"]), &pending); err != nil {
		t.Fatal(err)
	}
	revoked := f.ownerJSON(http.MethodDelete, "/live/sessions/"+f.sessionID+"/clients/"+f.clientID, f.ownerToken, nil)
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke pending client: %d %s", revoked.Code, revoked.Body.String())
	}
	select {
	case result := <-done:
		if result.resp.StatusCode != http.StatusUnauthorized || !bytes.Contains(result.body, []byte("MCP client authorization was revoked")) {
			t.Fatalf("revocation was misreported as request cancellation: %d %s", result.resp.StatusCode, result.body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("revocation did not wake the pending call")
	}
	cancelEvent := f.readEvent()
	if cancelEvent["event"] != "cancel" {
		t.Fatalf("expected browser cancellation event, got %#v", cancelEvent)
	}
	var cancellation map[string]string
	if err := json.Unmarshal([]byte(cancelEvent["data"]), &cancellation); err != nil {
		t.Fatal(err)
	}
	if cancellation["requestId"] != pending["requestId"] || cancellation["reason"] != "client_revoked" {
		t.Fatalf("revocation event does not match pending request: %#v", cancellation)
	}
}

func TestLiveMCPInitializationCompatibilityAndOriginChecks(t *testing.T) {
	f := newLiveFixture(t, []string{"workspace_info"}, []string{"workspace_info"})
	resp, body := f.mcpRequest("initialize", 1, map[string]any{"protocolVersion": legacyMCPVersion, "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test", "version": "1"}}, f.clientToken, legacyMCPVersion)
	if resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(legacyMCPVersion)) {
		t.Fatalf("legacy initialize failed: %d %s", resp.StatusCode, body)
	}
	badReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
	badReq.Host = "evil.example"
	badReq.Header.Set("Accept", "application/json, text/event-stream")
	badReq.Header.Set("Content-Type", "application/json")
	badReq.Header.Set("MCP-Protocol-Version", currentMCPVersion)
	badReq.Header.Set("Mcp-Method", "tools/list")
	badReq.Header.Set("Authorization", "Bearer "+f.clientToken)
	bad := httptest.NewRecorder()
	f.registry.MCPHandler().ServeHTTP(bad, badReq)
	if bad.Code != http.StatusForbidden {
		t.Fatalf("DNS rebinding Host accepted: %d", bad.Code)
	}
	badReq = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`))
	badReq.Host = strings.TrimPrefix(f.server.URL, "http://")
	badReq.Header.Set("Origin", "https://attacker.example")
	badReq.Header.Set("Accept", "application/json, text/event-stream")
	badReq.Header.Set("Content-Type", "application/json")
	badReq.Header.Set("MCP-Protocol-Version", currentMCPVersion)
	badReq.Header.Set("Mcp-Method", "tools/list")
	badReq.Header.Set("Authorization", "Bearer "+f.clientToken)
	bad = httptest.NewRecorder()
	f.registry.MCPHandler().ServeHTTP(bad, badReq)
	if bad.Code != http.StatusForbidden {
		t.Fatalf("foreign Origin accepted: %d", bad.Code)
	}
}

func TestMCPCurrentProtocolMetadataAndBrowserPreflight(t *testing.T) {
	f := newLiveFixture(t, []string{"workspace_info"}, []string{"workspace_info"})
	preflight := httptest.NewRequest(http.MethodOptions, "/mcp", nil)
	preflight.Host = strings.TrimPrefix(f.server.URL, "http://")
	preflight.Header.Set("Origin", testHostOrigin)
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	preflight.Header.Set("Access-Control-Request-Headers", "accept, authorization, content-type, mcp-protocol-version, mcp-method, mcp-name")
	allowed := httptest.NewRecorder()
	f.registry.MCPHandler().ServeHTTP(allowed, preflight)
	if allowed.Code != http.StatusNoContent || allowed.Header().Get("Access-Control-Allow-Origin") != testHostOrigin {
		t.Fatalf("Host-origin preflight failed: %d %#v", allowed.Code, allowed.Header())
	}
	preflight.Header.Set("Origin", "https://attacker.example")
	denied := httptest.NewRecorder()
	f.registry.MCPHandler().ServeHTTP(denied, preflight)
	if denied.Code != http.StatusForbidden || denied.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("foreign-origin preflight was not rejected: %d %#v", denied.Code, denied.Header())
	}

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25"}}}`
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = strings.TrimPrefix(f.server.URL, "http://")
	req.Header.Set("Authorization", "Bearer "+f.clientToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", currentMCPVersion)
	req.Header.Set("Mcp-Method", "tools/list")
	badMeta := httptest.NewRecorder()
	f.registry.MCPHandler().ServeHTTP(badMeta, req)
	if badMeta.Code != http.StatusBadRequest || !bytes.Contains(badMeta.Body.Bytes(), []byte(`"code":-32020`)) {
		t.Fatalf("header/body protocol version mismatch accepted: %d %s", badMeta.Code, badMeta.Body.String())
	}
	body = `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workspace_info","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`
	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = strings.TrimPrefix(f.server.URL, "http://")
	req.Header.Set("Authorization", "Bearer "+f.clientToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", currentMCPVersion)
	req.Header.Set("Mcp-Method", "tools/call")
	req.Header.Set("Mcp-Name", "git_status")
	badName := httptest.NewRecorder()
	f.registry.MCPHandler().ServeHTTP(badName, req)
	if badName.Code != http.StatusBadRequest || !bytes.Contains(badName.Body.Bytes(), []byte(`"code":-32020`)) {
		t.Fatalf("Mcp-Name/body mismatch accepted: %d %s", badName.Code, badName.Body.String())
	}
}

func TestLiveSessionDisconnectInvalidatesClientAndRejectsStaleResponse(t *testing.T) {
	f := newLiveFixture(t, []string{"workspace_info"}, []string{"workspace_info"})
	f.openEvents()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = f.mcpRequest("tools/call", 1, map[string]any{"name": "workspace_info", "arguments": map[string]any{}, "_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}}, f.clientToken, currentMCPVersion)
	}()
	event := f.readEvent()
	var request map[string]any
	_ = json.Unmarshal([]byte(event["data"]), &request)
	f.cancelStream()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("workspace disconnect did not release MCP call")
	}
	resp, body := f.mcpRequest("tools/list", 2, map[string]any{"_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion}}, f.clientToken, currentMCPVersion)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("client survived SSE disconnect: %d %s", resp.StatusCode, body)
	}
	stale := f.ownerJSON(http.MethodPost, "/live/sessions/"+f.sessionID+"/responses", f.ownerToken, map[string]any{"requestId": request["requestId"], "workspaceId": f.workspaceID, "generation": f.generation, "status": "completed", "result": map[string]any{"value": "late"}})
	if stale.Code == http.StatusAccepted {
		t.Fatalf("stale response accepted: %s", fmt.Sprint(request))
	}
}

func TestCurrentMCPDiscoveryAndCacheMetadata(t *testing.T) {
	f := newLiveFixture(t, []string{"workspace_info"}, []string{"workspace_info"})
	params := map[string]any{"_meta": map[string]any{"io.modelcontextprotocol/protocolVersion": currentMCPVersion, "io.modelcontextprotocol/clientInfo": map[string]string{"name": "sdk-test", "version": "1"}, "io.modelcontextprotocol/clientCapabilities": map[string]any{}}}
	for _, method := range []string{"server/discover", "tools/list"} {
		response, body := f.mcpRequest(method, 1, params, f.clientToken, currentMCPVersion)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s", method, response.StatusCode, body)
		}
		var envelope struct {
			Result map[string]any `json:"result"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Result["resultType"] != "complete" || envelope.Result["cacheScope"] != "private" || envelope.Result["ttlMs"] != float64(0) {
			t.Fatalf("invalid modern result: %s", body)
		}
		meta, _ := envelope.Result["_meta"].(map[string]any)
		info, _ := meta["io.modelcontextprotocol/serverInfo"].(map[string]any)
		if info["name"] != "proprium-gateway" {
			t.Fatalf("missing server identity: %s", body)
		}
		if method == "server/discover" {
			versions, _ := envelope.Result["supportedVersions"].([]any)
			if len(versions) != 1 || versions[0] != currentMCPVersion {
				t.Fatalf("invalid protocol discovery: %s", body)
			}
		}
	}
	response, _ := f.mcpRequest("server/discover", 2, params, "invalid-token", currentMCPVersion)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated discovery returned %d", response.StatusCode)
	}
}
