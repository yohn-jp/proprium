package main

import (
	"net/http"
)

type controlSnapshot struct {
	Sessions  int  `json:"sessions"`
	Streams   int  `json:"streams"`
	Pending   int  `json:"pending"`
	Quiescing bool `json:"quiescing"`
}

func (r *LiveRegistry) controlSnapshot() controlSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	snapshot := controlSnapshot{Sessions: len(r.sessions), Pending: r.registrations, Quiescing: r.quiescing}
	for _, session := range r.sessions {
		if session.stream {
			snapshot.Streams++
		}
		snapshot.Pending += len(session.pending)
	}
	return snapshot
}

func (r *LiveRegistry) quiesce(maintenance bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	pending := r.registrations
	for _, session := range r.sessions {
		pending += len(session.pending)
	}
	if !maintenance && (len(r.sessions) != 0 || pending != 0) {
		return false
	}
	r.quiescing = true
	return true
}

func (r *LiveRegistry) resume() {
	r.mu.Lock()
	r.quiescing = false
	r.mu.Unlock()
}

func (s *Server) controlRegistry() *LiveRegistry {
	r, _ := s.live.(*LiveRegistry)
	return r
}

func (s *Server) controlStatus(w http.ResponseWriter, _ *http.Request) {
	r := s.controlRegistry()
	if r == nil {
		http.Error(w, "control_unavailable", http.StatusServiceUnavailable)
		return
	}
	jsonResponse(w, http.StatusOK, r.controlSnapshot())
}

func (s *Server) controlQuiesce(w http.ResponseWriter, req *http.Request) {
	r := s.controlRegistry()
	if r == nil {
		http.Error(w, "control_unavailable", http.StatusServiceUnavailable)
		return
	}
	maintenance := req.Header.Get("X-Proprium-Maintenance") == "true"
	if !r.quiesce(maintenance) {
		jsonResponse(w, http.StatusConflict, map[string]string{"error": "active_live_work"})
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"quiescing": true})
}

func (s *Server) controlResume(w http.ResponseWriter, _ *http.Request) {
	r := s.controlRegistry()
	if r == nil {
		http.Error(w, "control_unavailable", http.StatusServiceUnavailable)
		return
	}
	r.resume()
	jsonResponse(w, http.StatusOK, map[string]bool{"quiescing": false})
}
