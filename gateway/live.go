package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	maxLiveBodyBytes        = 1 << 20
	maxLiveSessions         = 32
	maxLivePending          = 64
	liveEventQueue          = 128
	maxLiveName             = 128
	liveConnectWindow       = 60 * time.Second
	liveKeepaliveInterval   = 30 * time.Second
)

type LiveConfig struct{ HostOrigin, PublicURL, ListenAddr string }
type LiveRegistry struct {
    config LiveConfig
    keepaliveInterval time.Duration
    mu sync.Mutex
    sessions map[string]*liveSession
    activeSessionID string
    registrations int
    quiescing bool
}
type liveSession struct {
    id, workspaceID, generation string
    pending map[string]*livePending
    events chan liveEvent
    closed chan struct{}
    connectTimer *time.Timer
    stream, dead bool
}
type livePending struct {
    requestID string
    result chan liveResponse
    cancel func()
    response liveResponse
    settled bool
}
type liveEvent struct {
	name string
	data any
}
type liveResponse struct {
	status string
	result json.RawMessage
	err    string
}
type liveSessionRequest struct {
    WorkspaceID string `json:"workspaceId"`
    Generation string `json:"generation"`
}
type liveResponseRequest struct {
    RequestID string `json:"requestId"`
    WorkspaceID string `json:"workspaceId"`
    Generation string `json:"generation"`
    Status string `json:"status"`
    Result json.RawMessage `json:"result,omitempty"`
    Error string `json:"error,omitempty"`
}

func NewLiveRegistry(config LiveConfig) *LiveRegistry {
	return &LiveRegistry{config: config, keepaliveInterval: liveKeepaliveInterval, sessions: make(map[string]*liveSession)}
}

func registerLiveRoutes(s *Server) {
	r := NewLiveRegistry(LiveConfig{HostOrigin: s.config.HostOrigin, PublicURL: s.config.PublicURL, ListenAddr: s.config.ListenAddr})
	s.live = r
	s.mux.HandleFunc("/live/sessions", r.ServeHTTP)
	s.mux.HandleFunc("/live/sessions/", r.ServeHTTP)
}
func registerMCPRoute(s *Server) { s.mux.Handle("/mcp", s.live.MCPHandler()) }

func (r *LiveRegistry) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if !r.validLiveRequest(w, req) {
		return
	}
	if req.Method == http.MethodOptions {
		method := req.Header.Get("Access-Control-Request-Method")
		if !contains([]string{http.MethodGet, http.MethodPost, http.MethodDelete}, method) {
			liveJSON(w, req, r.config.HostOrigin, http.StatusForbidden, map[string]string{"error": "preflight_not_allowed"})
			return
		}
		for _, header := range strings.Split(strings.ToLower(req.Header.Get("Access-Control-Request-Headers")), ",") {
			header = strings.TrimSpace(header)
			if header != "" && !contains([]string{"authorization", "content-type", "accept"}, header) {
				liveJSON(w, req, r.config.HostOrigin, http.StatusForbidden, map[string]string{"error": "preflight_not_allowed"})
				return
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	path := strings.TrimPrefix(req.URL.Path, "/live/sessions")
	if path == "" {
		if req.Method != http.MethodPost {
			liveJSON(w, req, r.config.HostOrigin, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
			return
		}
		r.createSession(w, req)
		return
	}
	path = strings.TrimPrefix(path, "/")
	parts := strings.Split(path, "/")
	if parts[0] == "" || strings.Contains(parts[0], "%") {
		liveJSON(w, req, r.config.HostOrigin, http.StatusNotFound, map[string]string{"error": "route_not_found"})
		return
	}
	switch {
	case len(parts) == 2 && parts[1] == "events" && req.Method == http.MethodGet:
		r.events(w, req, parts[0])
	case len(parts) == 2 && parts[1] == "responses" && req.Method == http.MethodPost:
		r.acceptResponse(w, req, parts[0])
	case len(parts) == 1 && req.Method == http.MethodDelete:
		r.revokeSession(w, req, parts[0])
	default:
		liveJSON(w, req, r.config.HostOrigin, http.StatusNotFound, map[string]string{"error": "route_not_found"})
	}
}

func (r *LiveRegistry) validLiveRequest(w http.ResponseWriter, req *http.Request) bool {
	if req.URL.RawQuery != "" {
		liveJSON(w, req, r.config.HostOrigin, http.StatusBadRequest, map[string]string{"error": "query_not_allowed"})
		return false
	}
	if req.Header.Get("Origin") != r.config.HostOrigin || !validConfiguredOrigin(r.config.HostOrigin) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusForbidden, map[string]string{"error": "origin_not_allowed"})
		return false
	}
	if !r.validHost(req.Host) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusForbidden, map[string]string{"error": "host_not_allowed"})
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", r.config.HostOrigin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Vary", "Origin")
	return true
}
func (r *LiveRegistry) validHost(host string) bool {
	if host == "" {
		return false
	}
	if u, err := url.Parse(r.config.PublicURL); err == nil && u.Host != "" && strings.EqualFold(u.Host, host) {
		return true
	}
	if r.config.ListenAddr != "" {
		want := r.config.ListenAddr
		if strings.HasPrefix(want, ":") {
			want = "127.0.0.1" + want
		}
		if !strings.Contains(want, ":") {
			want = net.JoinHostPort(want, "80")
		}
		if strings.EqualFold(want, host) {
			return true
		}
	}
	return false
}
func validConfiguredOrigin(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" {
		return false
	}
	h, _, err := net.SplitHostPort(u.Host)
	if err != nil {
		h = u.Hostname()
	}
	return h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1"
}
func isJSONContentType(value string) bool {
	mime := strings.TrimSpace(strings.SplitN(value, ";", 2)[0])
	return strings.EqualFold(mime, "application/json")
}
func liveJSON(w http.ResponseWriter, req *http.Request, origin string, status int, body any) {
	if req != nil && req.Header.Get("Origin") != "" && req.Header.Get("Origin") == origin {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
func liveNoContent(w http.ResponseWriter, req *http.Request, origin string) {
	if req != nil && req.Header.Get("Origin") == origin {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusNoContent)
}
func readLiveJSON(w http.ResponseWriter, req *http.Request, out any) bool {
	origin := req.Header.Get("Origin")
	if req.Body == nil {
		liveJSON(w, req, origin, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return false
	}
	req.Body = http.MaxBytesReader(w, req.Body, maxLiveBodyBytes)
	dec := json.NewDecoder(req.Body)
	if err := dec.Decode(out); err != nil {
		status := http.StatusBadRequest
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		liveJSON(w, req, origin, status, map[string]string{"error": "invalid_request"})
		return false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		liveJSON(w, req, origin, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return false
	}
	return true
}
func randomLiveToken(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (r *LiveRegistry) sessionByID(_ *http.Request, id string) (*liveSession, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	return s, s != nil && !s.dead
}
func (r *LiveRegistry) createSession(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	if r.quiescing {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusServiceUnavailable, map[string]string{"error": "gateway_quiescing"})
		return
	}
	r.registrations++
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.registrations--
		r.mu.Unlock()
	}()
	if !isJSONContentType(req.Header.Get("Content-Type")) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnsupportedMediaType, map[string]string{"error": "json_required"})
		return
	}
	var input liveSessionRequest
	if !readLiveJSON(w, req, &input) {
		return
	}
    if len(input.WorkspaceID)<1 || len(input.WorkspaceID)>maxLiveName || len(input.Generation)<1 || len(input.Generation)>maxLiveName {
        liveJSON(w,req,r.config.HostOrigin,http.StatusBadRequest,map[string]string{"error":"invalid_session"})
        return
    }
    id,err:=randomLiveToken(16)
    if err!=nil {
        liveJSON(w,req,r.config.HostOrigin,http.StatusInternalServerError,map[string]string{"error":"internal_error"})
        return
    }
    session:=&liveSession{id:id,workspaceID:input.WorkspaceID,generation:input.Generation,pending:make(map[string]*livePending),events:make(chan liveEvent,liveEventQueue),closed:make(chan struct{})}
    r.mu.Lock()
    if r.quiescing {
        r.mu.Unlock()
        liveJSON(w,req,r.config.HostOrigin,http.StatusServiceUnavailable,map[string]string{"error":"gateway_quiescing"})
        return
    }
    if len(r.sessions)>=maxLiveSessions {
        r.mu.Unlock()
        liveJSON(w,req,r.config.HostOrigin,http.StatusServiceUnavailable,map[string]string{"error":"session_capacity_reached"})
        return
    }
    r.sessions[id]=session
    session.connectTimer=time.AfterFunc(liveConnectWindow,func(){r.expireSession(session)})
    r.mu.Unlock()
    liveJSON(w,req,r.config.HostOrigin,http.StatusCreated,map[string]string{"sessionId":id})
}

func (r *LiveRegistry) events(w http.ResponseWriter, req *http.Request, id string) {
	s, ok := r.sessionByID(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusInternalServerError, map[string]string{"error": "streaming_unavailable"})
		return
	}
	r.mu.Lock()
	if r.quiescing {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusServiceUnavailable, map[string]string{"error": "gateway_quiescing"})
		return
	}
	if s.dead || r.sessions[id] != s {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusGone, map[string]string{"error": "session_expired"})
		return
	}
	if s.stream {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusConflict, map[string]string{"error": "stream_already_connected"})
		return
	}
	s.stream = true
	// The most recently connected Browser Host is the active route.
	r.activeSessionID = s.id
	if s.connectTimer != nil {
		s.connectTimer.Stop()
		s.connectTimer = nil
	}
	r.mu.Unlock()
	defer r.expireSession(s)
	log.Print("Live Workspace stream connected")
	defer log.Print("Live Workspace stream disconnected")
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Access-Control-Allow-Origin", r.config.HostOrigin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Vary", "Origin")
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.WriteHeader(http.StatusOK)
	if !writeSSE(w, "ready", map[string]string{"sessionId": s.id, "workspaceId": s.workspaceID, "generation": s.generation}) {
		return
	}
	keepalive := time.NewTicker(r.keepaliveInterval)
	defer keepalive.Stop()
	for {
		select {
		case <-req.Context().Done():
			return
		case <-s.closed:
			return
		case <-keepalive.C:
			if !writeSSEComment(w) {
				return
			}
		case event := <-s.events:
			if !writeSSE(w, event.name, event.data) {
				return
			}
		}
	}
}
func writeSSE(w http.ResponseWriter, name string, value any) bool {
	data, err := json.Marshal(value)
	if err != nil {
		return false
	}
	if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data); err != nil {
		return false
	}
	return http.NewResponseController(w).Flush() == nil
}
func writeSSEComment(w http.ResponseWriter) bool {
	if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
		return false
	}
	return http.NewResponseController(w).Flush() == nil
}
func (r *LiveRegistry) expireSession(s *liveSession) {
	r.mu.Lock()
	if s.dead {
		r.mu.Unlock()
		return
	}
	s.dead = true
	delete(r.sessions, s.id)
	if r.activeSessionID == s.id { r.activeSessionID = "" }
	if s.connectTimer != nil {
		s.connectTimer.Stop()
		s.connectTimer = nil
	}
	var cancels []context.CancelFunc
	var results []struct {
		channel chan liveResponse
		value   liveResponse
	}
	for _, p := range s.pending {
		p.response = liveResponse{status: "unavailable", err: "workspace_disconnected"}
		p.settled = true
		cancels = append(cancels, p.cancel)
		results = append(results, struct {
			channel chan liveResponse
			value   liveResponse
		}{p.result, p.response})
	}
	s.pending = make(map[string]*livePending)
	r.mu.Unlock()
	close(s.closed)
	for _, result := range results {
		result.channel <- result.value
	}
	for _, cancel := range cancels {
		cancel()
	}
}

// Close invalidates every process-local authorization and wakes pending requests.
func (r *LiveRegistry) Close() {
	r.mu.Lock()
	sessions := make([]*liveSession, 0, len(r.sessions))
	for _, s := range r.sessions {
		sessions = append(sessions, s)
	}
	r.mu.Unlock()
	for _, s := range sessions {
		r.expireSession(s)
	}
}
func (r *LiveRegistry) acceptResponse(w http.ResponseWriter, req *http.Request, id string) {
	s, ok := r.sessionByID(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	if !isJSONContentType(req.Header.Get("Content-Type")) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnsupportedMediaType, map[string]string{"error": "json_required"})
		return
	}
	var input liveResponseRequest
	if !readLiveJSON(w, req, &input) {
		return
	}
	if input.RequestID == "" || len(input.RequestID) > 128 || input.WorkspaceID != s.workspaceID || input.Generation != s.generation || !contains([]string{"completed", "failed", "cancelled"}, input.Status) || len(input.Error) > 2048 || (input.Status == "completed" && len(input.Result) == 0) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusBadRequest, map[string]string{"error": "invalid_response"})
		return
	}
	r.mu.Lock()
	if s.dead || r.sessions[id] != s {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusGone, map[string]string{"error": "session_expired"})
		return
	}
	p := s.pending[input.RequestID]
	if p == nil {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusConflict, map[string]string{"error": "request_unknown_or_expired"})
		return
	}
	p.response = liveResponse{status: input.Status, result: input.Result, err: input.Error}
	p.settled = true
	delete(s.pending, input.RequestID)
	r.mu.Unlock()
	p.result <- p.response
	liveJSON(w, req, r.config.HostOrigin, http.StatusAccepted, map[string]bool{"accepted": true})
}
func (r *LiveRegistry) revokeSession(w http.ResponseWriter, req *http.Request, id string) {
	s, ok := r.sessionByID(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	r.expireSession(s)
	liveNoContent(w, req, r.config.HostOrigin)
}
func (r *LiveRegistry) dispatch(req *http.Request, tool string, args json.RawMessage) (liveResponse,error) {
    requestID,err:=randomLiveToken(16)
    if err!=nil {return liveResponse{},err}
    ctx,cancel:=context.WithTimeout(req.Context(),60*time.Second)
    defer cancel()
    p:=&livePending{requestID:requestID,result:make(chan liveResponse,1),cancel:cancel}
    r.mu.Lock()
    s:=r.sessions[r.activeSessionID]
    if r.quiescing || s==nil || s.dead || !s.stream {
        r.mu.Unlock()
        return liveResponse{status:"unavailable",err:"browser_unavailable"},nil
    }
    if len(s.pending)>=maxLivePending {
        r.mu.Unlock()
        return liveResponse{},errCapacity
    }
    event:=liveEvent{name:"request",data:map[string]any{"requestId":requestID,"workspaceId":s.workspaceID,"generation":s.generation,"tool":tool,"arguments":json.RawMessage(args),"deadline":time.Now().Add(60*time.Second).UnixMilli()}}
    select {
    case s.events<-event:
    default:
        r.mu.Unlock()
        return liveResponse{},errCapacity
    }
    s.pending[requestID]=p
    r.mu.Unlock()
    select {
    case result:=<-p.result:
        return result,nil
    case <-s.closed:
        if result,settled:=r.pendingOutcome(p);settled{return result,nil}
        return liveResponse{status:"unavailable",err:"workspace_disconnected"},nil
    case <-ctx.Done():
        if result,settled:=r.pendingOutcome(p);settled{return result,nil}
        reason,outcome:="cancelled","cancelled"
        if errors.Is(ctx.Err(),context.DeadlineExceeded) {reason,outcome="timeout","timeout"}
        response:=r.cancelPending(s,p,reason)
        if response.status=="" {response=liveResponse{status:outcome,err:"request_"+reason}}
        return response,nil
    }
}
func (r *LiveRegistry) pendingOutcome(p *livePending) (liveResponse, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return p.response, p.settled
}

func (r *LiveRegistry) cancelPending(s *liveSession, p *livePending, reason string) liveResponse {
	r.mu.Lock()
	response := liveResponse{}
	queueOverflow := false
	if s.pending[p.requestID] == p {
		outcome := "cancelled"
		message := "request_cancelled"
		if reason == "timeout" {
			outcome, message = "timeout", "request_timeout"
		}
		p.response = liveResponse{status: outcome, err: message}
		p.settled = true
		delete(s.pending, p.requestID)
		select {
		case s.events <- liveEvent{name: "cancel", data: map[string]string{"requestId": p.requestID, "workspaceId": s.workspaceID, "generation": s.generation, "reason": reason}}:
		default:
			queueOverflow = true
			p.response = liveResponse{status: "unavailable", err: "workspace_disconnected"}
		}
		response = p.response
	} else if p.settled {
		response = p.response
	}
	r.mu.Unlock()
	if queueOverflow {
		r.expireSession(s)
	}
	return response
}

var errCapabilityDenied = errors.New("capability_denied")
var errCapacity = errors.New("workspace_capacity_reached")

func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
// The active Host is selected by its latest SSE connection, not an MCP client token.
func (r *LiveRegistry) activeHostConnected() bool {
    r.mu.Lock()
    defer r.mu.Unlock()
    session:=r.sessions[r.activeSessionID]
    return !r.quiescing && session!=nil && !session.dead && session.stream
}
