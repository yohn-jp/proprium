package main

import (
    "bytes"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
)

func TestMCPRejectsUntrustedOrigin(t *testing.T) {
    f:=newLiveFixture(t)
    req:=httptest.NewRequest(http.MethodPost,"/mcp",strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
    req.Host=f.registry.config.ListenAddr
    req.Header.Set("Origin","https://untrusted.example")
    req.Header.Set("Content-Type","application/json")
    req.Header.Set("Accept","application/json, text/event-stream")
    req.Header.Set("MCP-Protocol-Version",legacyMCPVersion)
    recorder:=httptest.NewRecorder()
    f.registry.MCPHandler().ServeHTTP(recorder,req)
    if recorder.Code!=403 {t.Fatalf("origin policy bypassed: %d",recorder.Code)}
}

func TestMCPRejectsMalformedAndUnknownArguments(t *testing.T) {
    f:=newLiveFixture(t)
    cases:=[]struct{args string}{
        {`{"repository_id":"string"}`},
        {`{"repository_id":0}`},
        {`{"repository_id":12,"extra":"no"}`},
        {`{"repository_id":12,"limit":101}`},
    }
    for _,tc:=range cases {
        req:=httptest.NewRequest(http.MethodPost,"/mcp",strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_log","arguments":`+tc.args+`}}`))
        req.Host=f.registry.config.ListenAddr
        req.Header.Set("Content-Type","application/json")
        req.Header.Set("Accept","application/json, text/event-stream")
        req.Header.Set("MCP-Protocol-Version",legacyMCPVersion)
        recorder:=httptest.NewRecorder()
        f.registry.MCPHandler().ServeHTTP(recorder,req)
        if recorder.Code!=400 {t.Errorf("invalid params %s accepted: %d %s",tc.args,recorder.Code,recorder.Body.String())}
    }
}

func TestLiveSessionDoesNotIssueBearerCredentials(t *testing.T) {
    f:=newLiveFixture(t)
    status,body:=f.httpJSON(http.MethodPost,"/live/sessions",map[string]any{"workspaceId":"abc","generation":"def"})
    if status!=201 {t.Fatalf("session create: %d %s",status,body)}
    if bytes.Contains(body,[]byte("token")) || bytes.Contains(body,[]byte("Token")) {t.Fatalf("credential leaked in response: %s",body)}
    status,_=f.httpJSON(http.MethodPost,"/live/sessions/abc/clients",map[string]any{"name":"client"})
    if status!=404 {t.Fatalf("retired pairing route accessible: %d",status)}
}

func TestMCPInitializationBeforeActiveBrowser(t *testing.T) {
    f:=newLiveFixture(t)
    status,body:=f.mcp("initialize",map[string]any{"protocolVersion":legacyMCPVersion,"clientInfo":map[string]string{"name":"client","version":"1"}})
    if status!=200 || !bytes.Contains(body,[]byte(legacyMCPVersion)) {
        t.Fatalf("initialize failed before browser connection: %d %s",status,body)
    }
}
