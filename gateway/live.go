package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxLiveBodyBytes        = 1 << 20
	maxLiveSessions         = 32
	maxLiveClients          = 16
	maxLivePending          = 64
	liveEventQueue          = 128
	maxLiveName             = 128
	liveConnectWindow       = 60 * time.Second
	liveInactiveTokenWindow = 5 * time.Minute
	maxInactiveClientTokens = maxLiveSessions * maxLiveClients
	liveKeepaliveInterval   = 30 * time.Second
)

type LiveConfig struct{ OwnerKey, HostOrigin, PublicURL, ListenAddr string }
type LiveRegistry struct {
	config            LiveConfig
	keepaliveInterval time.Duration
	mu                sync.Mutex
	sessions          map[string]*liveSession
	clients           map[[32]byte]*liveClient
	inactiveTokens    map[[32]byte]time.Time
}
type liveSession struct {
	id, workspaceID, generation string
	ownerHash                   [32]byte
	capabilities                map[string]struct{}
	clients                     map[string]*liveClient
	pending                     map[string]*livePending
	events                      chan liveEvent
	closed                      chan struct{}
	connectTimer                *time.Timer
	stream, dead                bool
}
type liveClient struct {
	id, name     string
	tokenHash    [32]byte
	capabilities map[string]struct{}
	session      *liveSession
	inflight     map[string]func()
	rpcIDs       map[string]string
}
type livePending struct {
	requestID, rpcID string
	client           *liveClient
	result           chan liveResponse
	cancel           func()
	response         liveResponse
	settled          bool
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
	WorkspaceID  string   `json:"workspaceId"`
	Generation   string   `json:"generation"`
	Capabilities []string `json:"capabilities"`
}
type liveResponseRequest struct {
	RequestID   string          `json:"requestId"`
	WorkspaceID string          `json:"workspaceId"`
	Generation  string          `json:"generation"`
	Status      string          `json:"status"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       string          `json:"error,omitempty"`
}
type liveClientRequest struct {
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
}

func NewLiveRegistry(config LiveConfig) *LiveRegistry {
	return &LiveRegistry{config: config, keepaliveInterval: liveKeepaliveInterval, sessions: make(map[string]*liveSession), clients: make(map[[32]byte]*liveClient), inactiveTokens: make(map[[32]byte]time.Time)}
}

func registerLiveRoutes(s *Server) {
	r := NewLiveRegistry(LiveConfig{OwnerKey: s.config.OwnerKey, HostOrigin: s.config.HostOrigin, PublicURL: s.config.PublicURL, ListenAddr: s.config.ListenAddr})
	s.live = r
	s.mux.HandleFunc("/live/sessions", r.ServeHTTP)
	s.mux.HandleFunc("/live/sessions/", r.ServeHTTP)
}
func registerMCPRoute(s *Server) { s.mux.Handle("/mcp", s.live.MCPHandler()) }

func (r *LiveRegistry) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if r.config.OwnerKey == "" {
		liveJSON(w, req, r.config.HostOrigin, http.StatusServiceUnavailable, map[string]string{"error": "live_mcp_disabled"})
		return
	}
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
	case len(parts) == 2 && parts[1] == "clients":
		switch req.Method {
		case http.MethodGet:
			r.listClients(w, req, parts[0])
		case http.MethodPost:
			r.createClient(w, req, parts[0])
		default:
			liveJSON(w, req, r.config.HostOrigin, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		}
	case len(parts) == 3 && parts[1] == "clients" && req.Method == http.MethodDelete:
		r.revokeClient(w, req, parts[0], parts[2])
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
func bearerToken(req *http.Request) string {
	v := req.Header.Get("Authorization")
	const p = "Bearer "
	if !strings.HasPrefix(v, p) || len(v) <= len(p) || len(v) > len(p)+4096 || strings.ContainsAny(v[len(p):], " \t\r\n") {
		return ""
	}
	return v[len(p):]
}
func secureHash(v string) [32]byte { return sha256.Sum256([]byte(v)) }
func randomLiveToken(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (r *LiveRegistry) ownerSession(req *http.Request, id string) (*liveSession, bool) {
	token := bearerToken(req)
	if token == "" {
		return nil, false
	}
	hash := secureHash(token)
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	if s == nil || s.dead || subtle.ConstantTimeCompare(s.ownerHash[:], hash[:]) != 1 {
		return nil, false
	}
	return s, true
}
func (r *LiveRegistry) createSession(w http.ResponseWriter, req *http.Request) {
	token := bearerToken(req)
	if token == "" || len(token) != len(r.config.OwnerKey) || subtle.ConstantTimeCompare([]byte(token), []byte(r.config.OwnerKey)) != 1 {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "owner_authorization_required"})
		return
	}
	if !isJSONContentType(req.Header.Get("Content-Type")) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnsupportedMediaType, map[string]string{"error": "json_required"})
		return
	}
	var input liveSessionRequest
	if !readLiveJSON(w, req, &input) {
		return
	}
	if len(input.WorkspaceID) < 1 || len(input.WorkspaceID) > maxLiveName || len(input.Generation) < 1 || len(input.Generation) > maxLiveName || !validCapabilities(input.Capabilities) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusBadRequest, map[string]string{"error": "invalid_session"})
		return
	}
	id, err := randomLiveToken(16)
	if err != nil {
		liveJSON(w, req, r.config.HostOrigin, http.StatusInternalServerError, map[string]string{"error": "internal_error"})
		return
	}
	ownerToken, err := randomLiveToken(32)
	if err != nil {
		liveJSON(w, req, r.config.HostOrigin, http.StatusInternalServerError, map[string]string{"error": "internal_error"})
		return
	}
	caps := make(map[string]struct{}, len(input.Capabilities))
	for _, v := range input.Capabilities {
		caps[v] = struct{}{}
	}
	s := &liveSession{id: id, workspaceID: input.WorkspaceID, generation: input.Generation, ownerHash: secureHash(ownerToken), capabilities: caps, clients: make(map[string]*liveClient), pending: make(map[string]*livePending), events: make(chan liveEvent, liveEventQueue), closed: make(chan struct{})}
	r.mu.Lock()
	if len(r.sessions) >= maxLiveSessions {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusServiceUnavailable, map[string]string{"error": "session_capacity_reached"})
		return
	}
	r.sessions[id] = s
	s.connectTimer = time.AfterFunc(liveConnectWindow, func() { r.expireSession(s) })
	r.mu.Unlock()
	liveJSON(w, req, r.config.HostOrigin, http.StatusCreated, map[string]string{"sessionId": id, "ownerToken": ownerToken})
}
func validCapabilities(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, v := range values {
		if _, ok := liveTools[v]; !ok {
			return false
		}
		if _, ok := seen[v]; ok {
			return false
		}
		seen[v] = struct{}{}
	}
	return true
}

func (r *LiveRegistry) events(w http.ResponseWriter, req *http.Request, id string) {
	s, ok := r.ownerSession(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusInternalServerError, map[string]string{"error": "streaming_unavailable"})
		return
	}
	r.mu.Lock()
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
	if s.connectTimer != nil {
		s.connectTimer.Stop()
		s.connectTimer = nil
	}
	var cancels []context.CancelFunc
	var results []struct {
		channel chan liveResponse
		value   liveResponse
	}
	for _, c := range s.clients {
		delete(r.clients, c.tokenHash)
		r.rememberInactiveTokenLocked(c.tokenHash)
		for _, cancel := range c.inflight {
			cancels = append(cancels, cancel)
		}
		clear(c.inflight)
		clear(c.rpcIDs)
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

// rememberInactiveTokenLocked retains only a bounded, short-lived hash so a
// formerly authorized client receives an explicit unavailable response after
// a browser disconnects. It never keeps a usable bearer token.
func (r *LiveRegistry) rememberInactiveTokenLocked(hash [32]byte) {
	now := time.Now()
	for token, expiry := range r.inactiveTokens {
		if !now.Before(expiry) {
			delete(r.inactiveTokens, token)
		}
	}
	if len(r.inactiveTokens) >= maxInactiveClientTokens {
		var oldest [32]byte
		var earliest time.Time
		for token, expiry := range r.inactiveTokens {
			if earliest.IsZero() || expiry.Before(earliest) {
				oldest, earliest = token, expiry
			}
		}
		delete(r.inactiveTokens, oldest)
	}
	r.inactiveTokens[hash] = now.Add(liveInactiveTokenWindow)
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
	s, ok := r.ownerSession(req, id)
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
	if p.client != nil {
		delete(p.client.inflight, input.RequestID)
		delete(p.client.rpcIDs, p.rpcID)
	}
	r.mu.Unlock()
	p.result <- p.response
	liveJSON(w, req, r.config.HostOrigin, http.StatusAccepted, map[string]bool{"accepted": true})
}
func (r *LiveRegistry) createClient(w http.ResponseWriter, req *http.Request, id string) {
	s, ok := r.ownerSession(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	if !isJSONContentType(req.Header.Get("Content-Type")) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnsupportedMediaType, map[string]string{"error": "json_required"})
		return
	}
	var input liveClientRequest
	if !readLiveJSON(w, req, &input) {
		return
	}
	if len(strings.TrimSpace(input.Name)) < 1 || len(input.Name) > maxLiveName || !validCapabilities(input.Capabilities) {
		liveJSON(w, req, r.config.HostOrigin, http.StatusBadRequest, map[string]string{"error": "invalid_client"})
		return
	}
	idToken, err := randomLiveToken(16)
	if err != nil {
		liveJSON(w, req, r.config.HostOrigin, http.StatusInternalServerError, map[string]string{"error": "internal_error"})
		return
	}
	token, err := randomLiveToken(32)
	if err != nil {
		liveJSON(w, req, r.config.HostOrigin, http.StatusInternalServerError, map[string]string{"error": "internal_error"})
		return
	}
	caps := make(map[string]struct{}, len(input.Capabilities))
	for _, name := range input.Capabilities {
		if _, ok := s.capabilities[name]; !ok {
			liveJSON(w, req, r.config.HostOrigin, http.StatusForbidden, map[string]string{"error": "capability_not_published"})
			return
		}
		caps[name] = struct{}{}
	}
	client := &liveClient{id: idToken, name: strings.TrimSpace(input.Name), tokenHash: secureHash(token), capabilities: caps, session: s, inflight: make(map[string]func()), rpcIDs: make(map[string]string)}
	r.mu.Lock()
	if s.dead || r.sessions[id] != s {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusGone, map[string]string{"error": "session_expired"})
		return
	}
	if len(s.clients) >= maxLiveClients {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusServiceUnavailable, map[string]string{"error": "client_capacity_reached"})
		return
	}
	s.clients[client.id] = client
	r.clients[client.tokenHash] = client
	r.mu.Unlock()
	liveJSON(w, req, r.config.HostOrigin, http.StatusCreated, map[string]any{"clientId": client.id, "token": token})
}
func (r *LiveRegistry) listClients(w http.ResponseWriter, req *http.Request, id string) {
	s, ok := r.ownerSession(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	r.mu.Lock()
	clients := make([]map[string]any, 0, len(s.clients))
	for _, c := range s.clients {
		clients = append(clients, map[string]any{"clientId": c.id, "name": c.name, "capabilities": sortedKeys(c.capabilities)})
	}
	r.mu.Unlock()
	sort.Slice(clients, func(i, j int) bool { return clients[i]["clientId"].(string) < clients[j]["clientId"].(string) })
	liveJSON(w, req, r.config.HostOrigin, http.StatusOK, map[string]any{"clients": clients})
}
func (r *LiveRegistry) revokeClient(w http.ResponseWriter, req *http.Request, id, clientID string) {
	s, ok := r.ownerSession(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	r.mu.Lock()
	if s.dead || r.sessions[id] != s {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusGone, map[string]string{"error": "session_expired"})
		return
	}
	c := s.clients[clientID]
	if c == nil {
		r.mu.Unlock()
		liveJSON(w, req, r.config.HostOrigin, http.StatusNotFound, map[string]string{"error": "client_not_found"})
		return
	}
	delete(s.clients, clientID)
	delete(r.clients, c.tokenHash)
	var cancels []context.CancelFunc
	var results []struct {
		channel chan liveResponse
		value   liveResponse
	}
	queueOverflow := false
	for reqID, cancel := range c.inflight {
		if p := s.pending[reqID]; p != nil {
			delete(s.pending, reqID)
			delete(c.rpcIDs, p.rpcID)
			p.response = liveResponse{status: "revoked", err: "client_revoked"}
			p.settled = true
			results = append(results, struct {
				channel chan liveResponse
				value   liveResponse
			}{p.result, p.response})
			cancels = append(cancels, cancel)
			select {
			case s.events <- liveEvent{name: "cancel", data: map[string]string{"requestId": reqID, "workspaceId": s.workspaceID, "generation": s.generation, "reason": "client_revoked"}}:
			default:
				queueOverflow = true
			}
		} else {
			cancels = append(cancels, cancel)
		}
	}
	clear(c.inflight)
	clear(c.rpcIDs)
	r.mu.Unlock()
	for _, result := range results {
		result.channel <- result.value
	}
	for _, cancel := range cancels {
		cancel()
	}
	if queueOverflow {
		r.expireSession(s)
	}
	liveNoContent(w, req, r.config.HostOrigin)
}
func (r *LiveRegistry) revokeSession(w http.ResponseWriter, req *http.Request, id string) {
	s, ok := r.ownerSession(req, id)
	if !ok {
		liveJSON(w, req, r.config.HostOrigin, http.StatusUnauthorized, map[string]string{"error": "session_authorization_required"})
		return
	}
	r.expireSession(s)
	liveNoContent(w, req, r.config.HostOrigin)
}
func (r *LiveRegistry) findClient(token string) (*liveClient, string) {
	if token == "" {
		return nil, "unauthorized"
	}
	hash := secureHash(token)
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.clients[hash]
	if c == nil || c.session.dead || subtle.ConstantTimeCompare(c.tokenHash[:], hash[:]) != 1 {
		if expiry, ok := r.inactiveTokens[hash]; ok {
			if time.Now().Before(expiry) {
				return nil, "workspace_unavailable"
			}
			delete(r.inactiveTokens, hash)
		}
		return nil, "unauthorized"
	}
	return c, ""
}

func (r *LiveRegistry) dispatch(req *http.Request, client *liveClient, tool string, args json.RawMessage, rpcID string) (liveResponse, error) {
	requestID, err := randomLiveToken(16)
	if err != nil {
		return liveResponse{}, err
	}
	ctx, cancel := context.WithTimeout(req.Context(), 60*time.Second)
	p := &livePending{requestID: requestID, rpcID: rpcID, client: client, result: make(chan liveResponse, 1), cancel: cancel}
	s := client.session
	r.mu.Lock()
	if s.dead || r.sessions[s.id] != s || !s.stream || r.clients[client.tokenHash] != client {
		r.mu.Unlock()
		cancel()
		return liveResponse{status: "unavailable", err: "workspace_unavailable"}, nil
	}
	if _, ok := client.capabilities[tool]; !ok {
		r.mu.Unlock()
		cancel()
		return liveResponse{}, errCapabilityDenied
	}
	if len(s.pending) >= maxLivePending {
		r.mu.Unlock()
		cancel()
		return liveResponse{}, errCapacity
	}
	if _, exists := client.rpcIDs[rpcID]; exists {
		r.mu.Unlock()
		cancel()
		return liveResponse{}, errCapacity
	}
	deadline := time.Now().Add(60 * time.Second).UnixMilli()
	event := liveEvent{name: "request", data: map[string]any{"requestId": requestID, "workspaceId": s.workspaceID, "generation": s.generation, "tool": tool, "arguments": json.RawMessage(args), "deadline": deadline, "clientCapabilities": sortedKeys(client.capabilities)}}
	select {
	case s.events <- event:
	default:
		r.mu.Unlock()
		cancel()
		return liveResponse{}, errCapacity
	}
	s.pending[requestID] = p
	client.inflight[requestID] = cancel
	client.rpcIDs[rpcID] = requestID
	r.mu.Unlock()
	select {
	case response := <-p.result:
		cancel()
		return response, nil
	case <-s.closed:
		select {
		case response := <-p.result:
			cancel()
			return response, nil
		default:
		}
		if response, settled := r.pendingOutcome(p); settled {
			cancel()
			return response, nil
		}
		return liveResponse{status: "unavailable", err: "workspace_disconnected"}, nil
	case <-ctx.Done():
		select {
		case response := <-p.result:
			cancel()
			return response, nil
		default:
		}
		select {
		case <-s.closed:
			if response, settled := r.pendingOutcome(p); settled {
				cancel()
				return response, nil
			}
			return liveResponse{status: "unavailable", err: "workspace_disconnected"}, nil
		default:
		}
		reason, outcome, message := "cancelled", "cancelled", "request_cancelled"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			reason, outcome, message = "timeout", "timeout", "request_timeout"
		}
		response := r.cancelPending(s, p, reason)
		cancel()
		if response.status == "" {
			response = liveResponse{status: outcome, err: message}
		}
		return response, nil
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
		delete(p.client.inflight, p.requestID)
		delete(p.client.rpcIDs, p.rpcID)
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
func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
