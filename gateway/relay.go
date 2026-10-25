package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	maxOAuthRequestBytes  = 2_048
	maxOAuthResponseBytes = 8_192
	maxSmartHTTPBytes     = 50 << 20
)

var smartPathPattern = regexp.MustCompile(`^/git/([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100})\.git/(info/refs|git-upload-pack|git-receive-pack)$`)

type smartRoute struct {
	owner      string
	repository string
	endpoint   string
	service    string
}

func parseSmartRoute(r *http.Request) (smartRoute, bool) {
	if r.URL.RawPath != "" && r.URL.RawPath != r.URL.Path || r.URL.EscapedPath() != r.URL.Path {
		return smartRoute{}, false
	}
	match := smartPathPattern.FindStringSubmatch(r.URL.Path)
	if match == nil || match[1] == "." || match[1] == ".." || match[2] == "." || match[2] == ".." {
		return smartRoute{}, false
	}
	route := smartRoute{owner: match[1], repository: match[2], endpoint: match[3]}
	if route.endpoint == "info/refs" {
		values, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(values) != 1 || len(values["service"]) != 1 {
			return smartRoute{}, false
		}
		route.service = values.Get("service")
		if route.service != "git-upload-pack" && route.service != "git-receive-pack" {
			return smartRoute{}, false
		}
	} else if r.URL.RawQuery != "" {
		return smartRoute{}, false
	}
	return route, true
}

func (s *Server) handleGit(w http.ResponseWriter, r *http.Request) {
	route, ok := parseSmartRoute(r)
	if !ok {
		s.writeRelayError(w, http.StatusNotFound, "route_not_found")
		return
	}
	origin, ok := s.checkOrigin(w, r)
	if !ok {
		return
	}
	service := route.service
	if route.endpoint == "git-upload-pack" {
		service = "git-upload-pack"
	} else if route.endpoint == "git-receive-pack" {
		service = "git-receive-pack"
	}
	allowedMethod := http.MethodGet
	if route.endpoint != "info/refs" {
		allowedMethod = http.MethodPost
	}
	if r.Method == http.MethodOptions {
		s.handlePreflight(w, r, origin, allowedMethod, true)
		return
	}
	if r.Method != allowedMethod {
		s.writeCorsError(w, http.StatusMethodNotAllowed, "method_not_allowed", origin)
		return
	}
	if route.endpoint == "info/refs" && route.service != service {
		s.writeCorsError(w, http.StatusBadRequest, "git_service_not_allowed", origin)
		return
	}
	if r.Method == http.MethodPost {
		if strings.ToLower(r.Header.Get("Content-Type")) != "application/x-"+service+"-request" {
			s.writeCorsError(w, http.StatusUnsupportedMediaType, "git_content_type_not_allowed", origin)
			return
		}
		if r.ContentLength > maxSmartHTTPBytes {
			s.writeCorsError(w, http.StatusRequestEntityTooLarge, "git_request_too_large", origin)
			return
		}
	}
	token, ok := bearer(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", "Bearer")
		s.writeCorsError(w, http.StatusUnauthorized, "authentication_required", origin)
		return
	}
	rawRepoID := r.Header.Get("X-Proprium-Repository-Id")
	if len(rawRepoID) == 0 || len(rawRepoID) > 16 || rawRepoID[0] == '0' {
		s.writeCorsError(w, http.StatusUnauthorized, "authentication_required", origin)
		return
	}
	repoID, err := strconv.ParseInt(rawRepoID, 10, 64)
	if err != nil || repoID <= 0 || repoID > 9007199254740991 {
		s.writeCorsError(w, http.StatusUnauthorized, "authentication_required", origin)
		return
	}
	permission := "pull"
	if service == "git-receive-pack" {
		permission = "push"
	}
	if status := s.verifyRepository(r.Context(), route, repoID, permission, token); status != 0 {
		message := "repository_permission_denied"
		if status == http.StatusNotFound {
			message = "repository_mismatch"
		}
		s.writeCorsError(w, status, message, origin)
		return
	}
	s.forwardGit(w, r, route, service, token, origin)
}

func (s *Server) checkOrigin(w http.ResponseWriter, r *http.Request) (string, bool) {
	origin := r.Header.Get("Origin")
	if origin == "" || origin != s.config.HostOrigin {
		s.writeRelayError(w, http.StatusForbidden, "origin_not_allowed")
		return "", false
	}
	return origin, true
}

func (s *Server) handlePreflight(w http.ResponseWriter, r *http.Request, origin, method string, git bool) {
	requestedMethod := r.Header.Get("Access-Control-Request-Method")
	if requestedMethod != method {
		s.writeCorsError(w, http.StatusForbidden, "preflight_not_allowed", origin)
		return
	}
	allowed := map[string]bool{"content-type": true}
	if git {
		allowed = map[string]bool{
			"accept": true, "authorization": true, "content-type": true,
			"git-protocol": true, "x-proprium-repository-id": true,
		}
	}
	for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		header = strings.ToLower(strings.TrimSpace(header))
		if header != "" && !allowed[header] {
			s.writeCorsError(w, http.StatusForbidden, "preflight_not_allowed", origin)
			return
		}
	}
	setCORS(w, origin)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleOAuth(w http.ResponseWriter, r *http.Request) {
	origin, ok := s.checkOrigin(w, r)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		s.writeCorsError(w, http.StatusNotFound, "route_not_found", origin)
		return
	}
	if r.Method == http.MethodOptions {
		s.handlePreflight(w, r, origin, http.MethodPost, false)
		return
	}
	if r.Method != http.MethodPost {
		s.writeCorsError(w, http.StatusMethodNotAllowed, "method_not_allowed", origin)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		s.writeCorsError(w, http.StatusUnsupportedMediaType, "json_required", origin)
		return
	}
	if r.ContentLength > maxOAuthRequestBytes {
		s.writeCorsError(w, http.StatusRequestEntityTooLarge, "request_too_large", origin)
		return
	}
	body, err := readLimited(r.Context(), w, r.Body, maxOAuthRequestBytes)
	if err != nil {
		if errors.Is(err, errTooLarge) {
			s.writeCorsError(w, http.StatusRequestEntityTooLarge, "request_too_large", origin)
		} else {
			s.writeCorsError(w, http.StatusBadRequest, "invalid_request", origin)
		}
		return
	}
	var input map[string]any
	if err := decodeObject(body, &input); err != nil {
		s.writeCorsError(w, http.StatusBadRequest, "invalid_request", origin)
		return
	}
	endpoint := "https://github.com/login/oauth/access_token"
	form := url.Values{"client_id": {s.config.GitHubClientID}}
	fields := []string{"access_token", "token_type", "error", "error_description", "interval"}
	if r.URL.Path == "/oauth/device/code" {
		if len(input) != 0 {
			s.writeCorsError(w, http.StatusBadRequest, "invalid_request", origin)
			return
		}
		endpoint = "https://github.com/login/device/code"
		form.Set("scope", "repo")
		fields = []string{"device_code", "user_code", "verification_uri", "expires_in", "interval", "error", "error_description"}
	} else if r.URL.Path == "/oauth/token" {
		if len(input) != 1 {
			s.writeCorsError(w, http.StatusBadRequest, "invalid_request", origin)
			return
		}
		deviceCode, ok := input["deviceCode"].(string)
		if !ok || !isDeviceCode(deviceCode) {
			s.writeCorsError(w, http.StatusBadRequest, "invalid_request", origin)
			return
		}
		form.Set("device_code", deviceCode)
		form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	} else {
		s.writeCorsError(w, http.StatusNotFound, "route_not_found", origin)
		return
	}
	upstreamRequest, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		s.writeCorsError(w, http.StatusBadGateway, "oauth_upstream_unavailable", origin)
		return
	}
	upstreamRequest.Header.Set("Accept", "application/json")
	upstreamRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	upstream, err := s.client.Do(upstreamRequest)
	if err != nil {
		s.writeCorsError(w, http.StatusBadGateway, "oauth_upstream_unavailable", origin)
		return
	}
	defer upstream.Body.Close()
	if upstream.StatusCode >= 300 && upstream.StatusCode < 400 {
		s.writeCorsError(w, http.StatusBadGateway, "oauth_redirect_rejected", origin)
		return
	}
	payload, err := readLimited(r.Context(), nil, upstream.Body, maxOAuthResponseBytes)
	if err != nil {
		s.writeCorsError(w, http.StatusBadGateway, "oauth_response_invalid", origin)
		return
	}
	var response map[string]any
	if err := decodeObject(payload, &response); err != nil {
		s.writeCorsError(w, http.StatusBadGateway, "oauth_response_invalid", origin)
		return
	}
	filtered := make(map[string]any)
	for _, field := range fields {
		value, exists := response[field]
		if !exists {
			continue
		}
		switch v := value.(type) {
		case string:
			if len(v) <= 4096 {
				filtered[field] = v
			}
		case json.Number:
			if n, err := strconv.ParseInt(string(v), 10, 64); err == nil && n >= 0 {
				filtered[field] = n
			}
		}
	}
	encoded, _ := json.Marshal(filtered)
	if len(encoded) > maxOAuthResponseBytes {
		s.writeCorsError(w, http.StatusBadGateway, "oauth_response_invalid", origin)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	setJSONHeaders(w)
	w.WriteHeader(upstream.StatusCode)
	_, _ = w.Write(encoded)
}

func isDeviceCode(s string) bool {
	if len(s) < 1 || len(s) > 256 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func (s *Server) verifyRepository(ctx context.Context, route smartRoute, repositoryID int64, permission, token string) int {
	endpoint := "https://api.github.com/repos/" + route.owner + "/" + route.repository
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return http.StatusBadGateway
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := s.client.Do(request)
	if err != nil {
		return http.StatusBadGateway
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusMovedPermanently || response.StatusCode == http.StatusFound || response.StatusCode == http.StatusSeeOther {
			return http.StatusBadGateway
		}
		return response.StatusCode
	}
	body, err := readLimited(ctx, nil, response.Body, maxOAuthResponseBytes)
	if err != nil {
		return http.StatusBadGateway
	}
	var metadata map[string]any
	if err := decodeObject(body, &metadata); err != nil {
		return http.StatusBadGateway
	}
	id, ok := metadata["id"].(json.Number)
	if !ok {
		return http.StatusBadGateway
	}
	actualID, err := strconv.ParseInt(string(id), 10, 64)
	if err != nil || actualID != repositoryID {
		return http.StatusNotFound
	}
	fullName, ok := metadata["full_name"].(string)
	if !ok || !strings.EqualFold(fullName, route.owner+"/"+route.repository) {
		return http.StatusNotFound
	}
	permissions, ok := metadata["permissions"].(map[string]any)
	if !ok || permissions[permission] != true {
		return http.StatusForbidden
	}
	return 0
}

func (s *Server) forwardGit(w http.ResponseWriter, r *http.Request, route smartRoute, service, token, origin string) {
	upstreamURL := "https://github.com/" + route.owner + "/" + route.repository + ".git/" + route.endpoint
	if route.endpoint == "info/refs" {
		upstreamURL += "?service=" + url.QueryEscape(service)
	}
	var body io.Reader
	if r.Method == http.MethodPost {
		body = http.MaxBytesReader(w, r.Body, maxSmartHTTPBytes)
	}
	request, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL, body)
	if err != nil {
		s.writeCorsError(w, http.StatusBadGateway, "git_upstream_unavailable", origin)
		return
	}
	request.ContentLength = r.ContentLength
	request.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token)))
	if accept := r.Header.Get("Accept"); accept != "" && len(accept) <= 256 {
		request.Header.Set("Accept", accept)
	}
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if r.Header.Get("Git-Protocol") == "version=2" {
		request.Header.Set("Git-Protocol", "version=2")
	}
	upstream, err := s.client.Do(request)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			s.writeCorsError(w, http.StatusRequestEntityTooLarge, "git_request_too_large", origin)
		} else {
			s.writeCorsError(w, http.StatusBadGateway, "git_upstream_unavailable", origin)
		}
		return
	}
	defer upstream.Body.Close()
	if upstream.StatusCode >= 300 && upstream.StatusCode < 400 {
		s.writeCorsError(w, http.StatusBadGateway, "git_redirect_rejected", origin)
		return
	}
	if upstream.ContentLength > maxSmartHTTPBytes {
		s.writeCorsError(w, http.StatusBadGateway, "git_response_too_large", origin)
		return
	}
	setCORS(w, origin)
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if contentType := upstream.Header.Get("Content-Type"); allowedGitContentType(contentType) {
		w.Header().Set("Content-Type", contentType)
	}
	if upstream.Header.Get("Git-Protocol") == "version=2" {
		w.Header().Set("Git-Protocol", "version=2")
	}
	w.WriteHeader(upstream.StatusCode)
	copyGitResponse(w, upstream.Body, maxSmartHTTPBytes)
}

func copyGitResponse(w http.ResponseWriter, src io.Reader, maximum int64) {
	remaining := maximum
	buffer := make([]byte, 32<<10)
	for remaining > 0 {
		readSize := int64(len(buffer))
		if readSize > remaining {
			readSize = remaining
		}
		n, err := src.Read(buffer[:readSize])
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return
			}
			remaining -= int64(n)
		}
		if err != nil {
			return
		}
		if n == 0 {
			return
		}
	}
}

func allowedGitContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return false
	}
	return strings.HasPrefix(mediaType, "application/x-git-") || mediaType == "application/json"
}

var errTooLarge = errors.New("request body too large")

func readLimited(ctx context.Context, writer http.ResponseWriter, body io.Reader, limit int64) ([]byte, error) {
	if body == nil {
		return nil, errors.New("empty body")
	}
	limited := io.LimitReader(body, limit+1)
	var buffer bytes.Buffer
	chunk := make([]byte, 32<<10)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, err := limited.Read(chunk)
		if n > 0 {
			if int64(buffer.Len()+n) > limit {
				return nil, errTooLarge
			}
			_, _ = buffer.Write(chunk[:n])
		}
		if err == io.EOF {
			return buffer.Bytes(), nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func decodeObject(data []byte, target *map[string]any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing JSON data")
	}
	if *target == nil {
		return errors.New("JSON object required")
	}
	return nil
}

func (s *Server) writeRelayError(w http.ResponseWriter, status int, code string) {
	jsonResponse(w, status, map[string]string{"error": code})
}

func (s *Server) writeCorsError(w http.ResponseWriter, status int, code, origin string) {
	setCORS(w, origin)
	jsonResponse(w, status, map[string]string{"error": code})
}

func setCORS(w http.ResponseWriter, origin string) {
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Git-Protocol, X-Proprium-Repository-Id")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Set("Vary", "Origin")
}

func setJSONHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Vary", "Origin")
}
