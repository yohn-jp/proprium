package main

import (
    "bytes"
    "encoding/json"
    "io"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
    "time"
)

// A Tunnel terminates TLS and preserves the public Host on requests to the
// loopback Gateway. Access authentication occurs at the edge, not in this test.
func TestTunnelLikeHTTPSReverseProxyExposesStaticMCPTools(t *testing.T) {
    cfg:=Config{
        ListenAddr:"127.0.0.1:8080",
        HostOrigin:testHostOrigin,
        PublicURL:"https://gateway.proprium.example",
        GitHubClientID:"abcdefghij",
        UpstreamTimeout:5*time.Second,
    }
    gateway,err:=NewServer(cfg)
    if err!=nil {t.Fatal(err)}
    defer gateway.Close()
    proxy:=httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
        r.Host="gateway.proprium.example"
        gateway.Handler().ServeHTTP(w,r)
    }))
    defer proxy.Close()
    request,err:=http.NewRequest(http.MethodPost,proxy.URL+"/mcp",strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
    if err!=nil {t.Fatal(err)}
    request.Header.Set("Content-Type","application/json")
    request.Header.Set("Accept","application/json, text/event-stream")
    request.Header.Set("MCP-Protocol-Version",legacyMCPVersion)
    response,err:=proxy.Client().Do(request)
    if err!=nil {t.Fatal(err)}
    defer response.Body.Close()
    raw,err:=io.ReadAll(response.Body)
    if err!=nil {t.Fatal(err)}
    if response.StatusCode!=200 {t.Fatalf("MCP tools/list: %d %s",response.StatusCode,raw)}
    var envelope struct {Result struct{Tools []struct{Name string `json:"name"`} `json:"tools"`} `json:"result"`}
    if err:=json.Unmarshal(raw,&envelope);err!=nil {t.Fatal(err)}
    if len(envelope.Result.Tools)!=8 {t.Fatalf("expected all 8 tools, got %d: %s",len(envelope.Result.Tools),raw)}
    if bytes.Contains(raw,[]byte("Bearer")) || response.Header.Get("WWW-Authenticate")!="" {t.Fatal("obsolete Proprium authentication challenged MCP client")}
}

func TestGatewayProxyRejectsWrongHost(t *testing.T) {
    cfg:=Config{ListenAddr:"127.0.0.1:8080",HostOrigin:testHostOrigin,PublicURL:"https://gateway.proprium.example",GitHubClientID:"abcdefghij",UpstreamTimeout:5*time.Second}
    gateway,err:=NewServer(cfg)
    if err!=nil {t.Fatal(err)}
    defer gateway.Close()
    req:=httptest.NewRequest(http.MethodGet,"http://wrong.example/healthz",nil)
    recorder:=httptest.NewRecorder()
    gateway.Handler().ServeHTTP(recorder,req)
    if recorder.Code!=http.StatusMisdirectedRequest {t.Fatalf("bad Host not blocked: %d",recorder.Code)}
}
