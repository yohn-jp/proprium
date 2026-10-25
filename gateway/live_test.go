package main

import (
    "bufio"
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "net/http/httptest"
    "net/url"
    "strings"
    "testing"
    "time"
)

const testHostOrigin = "https://proprium.example"

type liveFixture struct {
    t *testing.T
    registry *LiveRegistry
    server *httptest.Server
}

func newLiveFixture(t *testing.T) *liveFixture {
    t.Helper()
    r := NewLiveRegistry(LiveConfig{HostOrigin:testHostOrigin})
    mux := http.NewServeMux()
    mux.HandleFunc("/live/sessions",r.ServeHTTP)
    mux.HandleFunc("/live/sessions/",r.ServeHTTP)
    mux.Handle("/mcp",r.MCPHandler())
    srv := httptest.NewServer(mux)
    host,err := url.Parse(srv.URL)
    if err != nil { t.Fatal(err) }
    r.config.ListenAddr = host.Host
    f := &liveFixture{t:t,registry:r,server:srv}
    t.Cleanup(func(){r.Close();srv.Close()})
    return f
}

func (f *liveFixture) httpJSON(method,path string, input any) (int,[]byte) {
    f.t.Helper()
    var body []byte
    if input!=nil { body,_=json.Marshal(input) }
    req,err:=http.NewRequest(method,f.server.URL+path,bytes.NewReader(body))
    if err!=nil { f.t.Fatal(err) }
    req.Header.Set("Origin",testHostOrigin)
    req.Header.Set("Content-Type","application/json")
    resp,err:=http.DefaultClient.Do(req)
    if err!=nil {f.t.Fatal(err)}
    defer resp.Body.Close()
    b:=make([]byte,1<<20)
    n,_:=resp.Body.Read(b)
    return resp.StatusCode,b[:n]
}

func (f *liveFixture) createSession(name string) string {
    f.t.Helper()
    status,body:=f.httpJSON("POST","/live/sessions",map[string]any{"workspaceId":name,"generation":"generation-1"})
    if status!=201 { f.t.Fatalf("session create: %d %s",status,body)}
    var obj map[string]any
    if json.Unmarshal(body,&obj)!=nil {f.t.Fatal("not json")}
    if _,ok:=obj["ownerToken"];ok { f.t.Fatal("owner token must never be returned") }
    return obj["sessionId"].(string)
}

func (f *liveFixture) openEvents(session string) (*http.Response,*bufio.Reader,context.CancelFunc) {
    f.t.Helper()
    ctx,cancel:=context.WithCancel(context.Background())
    req,err:=http.NewRequestWithContext(ctx,"GET",f.server.URL+"/live/sessions/"+session+"/events",nil)
    if err!=nil {f.t.Fatal(err)}
    req.Header.Set("Origin",testHostOrigin)
    resp,err:=http.DefaultClient.Do(req)
    if err!=nil {cancel();f.t.Fatal(err)}
    if resp.StatusCode!=200 {resp.Body.Close();cancel();f.t.Fatalf("SSE status %d",resp.StatusCode)}
    reader:=bufio.NewReader(resp.Body)
    f.readEvent(reader) // ready
    return resp,reader,func(){cancel();resp.Body.Close()}
}

func (f *liveFixture) readEvent(reader *bufio.Reader) map[string]any {
    f.t.Helper()
    for i:=0;i<20;i++ {
        line,err:=reader.ReadString('\n')
        if err!=nil {f.t.Fatalf("SSE read: %v",err)}
        if strings.HasPrefix(line,"data: ") {
            var value map[string]any
            if err:=json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line,"data: "))),&value);err!=nil {f.t.Fatal(err)}
            return value
        }
    }
    f.t.Fatal("SSE event not received")
    return nil
}

func (f *liveFixture) mcp(method string, params any) (int,[]byte) {
    f.t.Helper()
    return f.mcpContext(context.Background(),method,params)
}

func (f *liveFixture) mcpContext(ctx context.Context,method string,params any) (int,[]byte) {
    f.t.Helper()
    raw,_:=json.Marshal(map[string]any{"jsonrpc":"2.0","id":1,"method":method,"params":params})
    req,err:=http.NewRequestWithContext(ctx,"POST",f.server.URL+"/mcp",bytes.NewReader(raw))
    if err!=nil {f.t.Fatal(err)}
    req.Header.Set("Content-Type","application/json")
    req.Header.Set("Accept","application/json, text/event-stream")
    req.Header.Set("MCP-Protocol-Version",legacyMCPVersion)
    resp,err:=http.DefaultClient.Do(req)
    if err!=nil { f.t.Fatal(err) }
    defer resp.Body.Close()
    var b bytes.Buffer
    _,_ = b.ReadFrom(resp.Body)
    return resp.StatusCode,b.Bytes()
}

func TestToolsAlwaysListedWithoutSessionOrClientToken(t *testing.T) {
    f:=newLiveFixture(t)
    status,body:=f.mcp("tools/list",map[string]any{})
    if status!=200 {t.Fatalf("tools/list: %d %s",status,body)}
    for _,name:=range []string{"repositories_list","repository_info","files_list","file_read","git_status","git_log","plugin_call","proposal_submit"} {
        if !bytes.Contains(body,[]byte(fmt.Sprintf("\"name\":\"%s\"",name))) {t.Fatalf("missing %s: %s",name,body)}
    }
    if bytes.Contains(body,[]byte("capabilities_list")) || bytes.Contains(body,[]byte("workspace_info")) {t.Fatal("retired tools exposed")}
    status,_=f.mcp("tools/call",map[string]any{"name":"repositories_list","arguments":map[string]any{}})
    if status!=503 {t.Fatalf("expected no active browser, got %d",status)}
}

func TestActiveBrowserDispatchAndRepositoryID(t *testing.T) {
    f:=newLiveFixture(t)
    session:=f.createSession("host-A")
    _,reader,closeStream:=f.openEvents(session)
    defer closeStream()
    status,_:=f.httpJSON("GET","/live/sessions/"+session+"/clients",nil)
    if status!=404 {t.Fatalf("client token endpoint should not exist: %d",status)}
    done:=make(chan struct{status int;body []byte},1)
    go func(){code,body:=f.mcp("tools/call",map[string]any{"name":"repository_info","arguments":map[string]any{"repository_id":123,"branch":"main"}});done<-struct{status int;body []byte}{code,body}}()
    request:=f.readEvent(reader)
    if request["tool"]!="repository_info" {t.Fatalf("wrong tool %v",request)}
    args:=request["arguments"].(map[string]any)
    if args["repository_id"]!=float64(123) {t.Fatalf("lost repository ID %v",args)}
    code,payload:=f.httpJSON("POST","/live/sessions/"+session+"/responses",map[string]any{"requestId":request["requestId"],"workspaceId":"host-A","generation":"generation-1","status":"completed","result":map[string]any{"repository_id":123,"head":"abc"}})
    if code!=202 {t.Fatalf("Browser response rejected: %d %s",code,payload)}
    select {case result:=<-done:
        if result.status!=200||!bytes.Contains(result.body,[]byte("abc")) {t.Fatalf("MCP call %d %s",result.status,result.body)}
    case <-time.After(3*time.Second): t.Fatal("tool response timed out")}
}

func TestHostSelectionDoesNotFailOverAfterDisconnect(t *testing.T) {
    f:=newLiveFixture(t)
    first:=f.createSession("host-A")
    _,_,closeA:=f.openEvents(first)
    defer closeA()
    second:=f.createSession("host-B")
    _,_,closeB:=f.openEvents(second)
    defer closeB()
    statusActivate,_:=f.httpJSON("POST","/live/sessions/"+second+"/activate",map[string]any{})
    if statusActivate!=200 {t.Fatalf("explicit foreground activation: %d",statusActivate)}
    if !f.registry.activeHostConnected() || f.registry.activeSessionID!=second {t.Fatal("latest connected host must be active")}
    closeB()
    deadline:=time.Now().Add(2*time.Second)
    for time.Now().Before(deadline) {
        if !f.registry.activeHostConnected() {break}
        time.Sleep(10*time.Millisecond)
    }
    if f.registry.activeHostConnected() {t.Fatal("unexpected failover to stale Host A")}
    status,_:=f.mcp("tools/list",map[string]any{})
    if status!=200 {t.Fatalf("tools must remain discoverable: %d",status)}
    status,_=f.mcp("tools/call",map[string]any{"name":"repositories_list","arguments":map[string]any{}})
    if status!=503 {t.Fatalf("no active Host must fail closed, got %d",status)}
}

func TestRepositoryIDRequired(t *testing.T) {
    f:=newLiveFixture(t)
    _,body:=f.mcp("tools/call",map[string]any{"name":"git_status","arguments":map[string]any{}})
    if !bytes.Contains(body,[]byte("missing required tool argument")) {t.Fatalf("missing repository_id accepted: %s",body)}
}
