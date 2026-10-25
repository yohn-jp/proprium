package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func testServer(t *testing.T, roundTrip roundTripFunc) *Server {
	t.Helper()
	config := testConfig()
	server, err := NewServer(config)
	if err != nil {
		t.Fatal(err)
	}
	server.client = &http.Client{Transport: roundTrip, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect disabled") }}
	return server
}

func jsonResponseForTest(status int, body string, headers http.Header) *http.Response {
	if headers == nil {
		headers = make(http.Header)
	}
	return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body))}
}

func sendRequest(t *testing.T, server *Server, method, path, origin string, headers http.Header, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "https://gateway.example"+path, strings.NewReader(body))
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	for name, values := range headers {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, req)
	return response
}

func TestDeviceAuthorizationCodeRequestAndSanitizedResponse(t *testing.T) {
	var called atomic.Bool
	server := testServer(t, func(r *http.Request) (*http.Response, error) {
		called.Store(true)
		if r.URL.String() != "https://github.com/login/device/code" || r.Method != http.MethodPost {
			t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("OAuth device code request unexpectedly included authorization")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "client_id=abcdefghij&scope=repo" {
			t.Errorf("unexpected form: %s", body)
		}
		return jsonResponseForTest(200, `{"device_code":"secret-device","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5,"access_token":"must-not-be-forwarded","extra":"filtered"}`, nil), nil
	})
	headers := http.Header{"Content-Type": []string{"application/json"}}
	response := sendRequest(t, server, http.MethodPost, "/oauth/device/code", "https://host.example", headers, `{}`)
	if response.Code != http.StatusOK || !called.Load() {
		t.Fatalf("status=%d upstream=%v", response.Code, called.Load())
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "https://host.example" {
		t.Fatal("missing exact CORS origin")
	}
	if strings.Contains(response.Body.String(), "access_token") || strings.Contains(response.Body.String(), "extra") {
		t.Fatalf("unapproved fields forwarded: %s", response.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["device_code"] != "secret-device" || got["expires_in"] != float64(900) {
		t.Fatalf("unexpected response: %#v", got)
	}
}

func TestDeviceTokenExchangeUsesDeviceCodeOnlyInForm(t *testing.T) {
	server := testServer(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://github.com/login/oauth/access_token" {
			t.Errorf("wrong OAuth endpoint: %s", r.URL)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "client_id=abcdefghij&device_code=abc_DEF-123&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code" {
			t.Errorf("unexpected exchange body: %s", body)
		}
		return jsonResponseForTest(200, `{"access_token":"oauth-secret","token_type":"bearer","scope":"repo","extra":"filtered"}`, nil), nil
	})
	headers := http.Header{"Content-Type": []string{"application/json"}}
	response := sendRequest(t, server, http.MethodPost, "/oauth/token", "https://host.example", headers, `{"deviceCode":"abc_DEF-123"}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "oauth-secret") {
		t.Fatalf("token exchange response: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "scope") || strings.Contains(response.Body.String(), "extra") {
		t.Fatalf("unexpected fields forwarded: %s", response.Body.String())
	}
}

func TestOAuthRejectsOriginMethodShapeAndOversizedRequest(t *testing.T) {
	var calls atomic.Int32
	server := testServer(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return jsonResponseForTest(200, `{}`, nil), nil
	})
	if got := sendRequest(t, server, http.MethodPost, "/oauth/device/code", "https://attacker.example", http.Header{"Content-Type": []string{"application/json"}}, `{}`).Code; got != http.StatusForbidden {
		t.Fatalf("bad origin: %d", got)
	}
	if got := sendRequest(t, server, http.MethodGet, "/oauth/device/code", "https://host.example", nil, "").Code; got != http.StatusMethodNotAllowed {
		t.Fatalf("bad method: %d", got)
	}
	if got := sendRequest(t, server, http.MethodPost, "/oauth/token", "https://host.example", http.Header{"Content-Type": []string{"application/json"}}, `{"deviceCode":"../bad"}`).Code; got != http.StatusBadRequest {
		t.Fatalf("bad device code: %d", got)
	}
	if got := sendRequest(t, server, http.MethodPost, "/oauth/device/code", "https://host.example", http.Header{"Content-Type": []string{"application/json"}}, strings.Repeat("x", maxOAuthRequestBytes+1)).Code; got != http.StatusRequestEntityTooLarge {
		t.Fatalf("invalid oversized JSON: %d", got)
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid requests reached upstream %d times", calls.Load())
	}
}

func TestOAuthUpstreamRedirectAndFailureAreSanitized(t *testing.T) {
	server := testServer(t, func(*http.Request) (*http.Response, error) {
		return jsonResponseForTest(302, `{"access_token":"secret"}`, http.Header{"Location": []string{"https://evil.example"}}), nil
	})
	response := sendRequest(t, server, http.MethodPost, "/oauth/device/code", "https://host.example", http.Header{"Content-Type": []string{"application/json"}}, `{}`)
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "secret") || response.Header().Get("Location") != "" {
		t.Fatalf("redirect leaked upstream data: %d %s", response.Code, response.Body.String())
	}
	server.client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("token=secret") })}
	response = sendRequest(t, server, http.MethodPost, "/oauth/device/code", "https://host.example", http.Header{"Content-Type": []string{"application/json"}}, `{}`)
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("upstream error leaked: %d %s", response.Code, response.Body.String())
	}
}

func repoMetadata(permission string) string {
	return `{"id":42,"full_name":"Acme/Notes","permissions":{"` + permission + `":true}}`
}

func TestSmartHTTPUploadStreamsAndPreservesGitBytes(t *testing.T) {
	pack := []byte("0008NAK\nPACK\x00\xff")
	calls := 0
	server := testServer(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			if r.URL.String() != "https://api.github.com/repos/Acme/Notes" || r.Header.Get("Authorization") != "Bearer oauth-secret" {
				t.Errorf("unexpected repository lookup: %s auth=%q", r.URL, r.Header.Get("Authorization"))
			}
			return jsonResponseForTest(200, repoMetadata("pull"), nil), nil
		}
		if r.URL.String() != "https://github.com/Acme/Notes.git/info/refs?service=git-upload-pack" {
			t.Errorf("unbounded or wrong upstream URL: %s", r.URL)
		}
		if r.Header.Get("Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:oauth-secret")) {
			t.Errorf("wrong Smart HTTP authorization")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/x-git-upload-pack-advertisement"}, "Git-Protocol": []string{"version=2"}}, Body: io.NopCloser(bytes.NewReader(pack)), ContentLength: int64(len(pack))}, nil
	})
	headers := http.Header{"Authorization": []string{"Bearer oauth-secret"}, "X-Proprium-Repository-Id": []string{"42"}, "Accept": []string{"application/x-git-upload-pack-advertisement"}, "Git-Protocol": []string{"version=2"}}
	response := sendRequest(t, server, http.MethodGet, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", headers, "")
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), pack) {
		t.Fatalf("Git bytes changed: status=%d body=%v", response.Code, response.Body.Bytes())
	}
	if response.Header().Get("Git-Protocol") != "version=2" || response.Header().Get("Access-Control-Allow-Origin") != "https://host.example" {
		t.Fatalf("missing Git/CORS headers: %#v", response.Header())
	}
}

func TestSmartHTTPReceivePackChecksPushAndStreamsBody(t *testing.T) {
	pack := []byte("0008PACK\x00\xff")
	calls := 0
	server := testServer(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return jsonResponseForTest(200, repoMetadata("push"), nil), nil
		}
		if r.Method != http.MethodPost || r.ContentLength != int64(len(pack)) {
			t.Errorf("wrong pack request method/length: %s %d", r.Method, r.ContentLength)
		}
		if r.Header.Get("Content-Type") != "application/x-git-receive-pack-request" {
			t.Errorf("wrong content-type: %s", r.Header.Get("Content-Type"))
		}
		actual, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(actual, pack) {
			t.Errorf("request Git bytes changed: %v", actual)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/x-git-receive-pack-result"}}, Body: io.NopCloser(strings.NewReader("unpack ok\n")), ContentLength: 11}, nil
	})
	headers := http.Header{"Authorization": []string{"Bearer oauth-secret"}, "X-Proprium-Repository-Id": []string{"42"}, "Content-Type": []string{"application/x-git-receive-pack-request"}}
	request := httptest.NewRequest(http.MethodPost, "https://gateway.example/git/Acme/Notes.git/git-receive-pack", bytes.NewReader(pack))
	request.Header.Set("Origin", "https://host.example")
	for key, values := range headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "unpack ok\n" {
		t.Fatalf("receive-pack response: %d %q", response.Code, response.Body.String())
	}
}

func TestSmartHTTPDeniesBadOriginRepositoryPermissionAndArbitraryPaths(t *testing.T) {
	var gitCalls atomic.Int32
	server := testServer(t, func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.Host, "api.github.com") {
			return jsonResponseForTest(200, repoMetadata("pull"), nil), nil
		}
		gitCalls.Add(1)
		return jsonResponseForTest(200, `{}`, nil), nil
	})
	headers := http.Header{"Authorization": []string{"Bearer oauth-secret"}, "X-Proprium-Repository-Id": []string{"42"}}
	if got := sendRequest(t, server, http.MethodGet, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://evil.example", headers, "").Code; got != http.StatusForbidden {
		t.Fatalf("bad origin: %d", got)
	}
	badID := headers.Clone()
	badID.Set("X-Proprium-Repository-Id", "042")
	if got := sendRequest(t, server, http.MethodGet, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", badID, "").Code; got != http.StatusUnauthorized {
		t.Fatalf("bad repository ID syntax: %d", got)
	}
	for _, path := range []string{
		"/git/Acme/Notes.git/config", "/git/Acme/Notes.git/info/refs?service=git-upload-pack&x=y",
		"/git/Acme/Notes.git/info/refs?service=git-receive-pack",
		"/git/Acme/../secret.git/info/refs?service=git-upload-pack",
		"/git/Acme/Notes.git/git-upload-pack?next=https://evil.example",
	} {
		if got := sendRequest(t, server, http.MethodGet, path, "https://host.example", headers, "").Code; got == http.StatusOK {
			t.Errorf("unsupported Git path accepted: %s", path)
		}
	}
	if got := sendRequest(t, server, http.MethodGet, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", headers, "").Code; got != http.StatusOK {
		t.Errorf("valid read rejected: %d", got)
	}
	if gitCalls.Load() != 1 {
		t.Fatalf("unexpected Git upstream requests: %d", gitCalls.Load())
	}
}

func TestSmartHTTPPermissionAndMethodBoundaries(t *testing.T) {
	server := testServer(t, func(*http.Request) (*http.Response, error) {
		return jsonResponseForTest(200, repoMetadata("pull"), nil), nil
	})
	headers := http.Header{"Authorization": []string{"Bearer oauth-secret"}, "X-Proprium-Repository-Id": []string{"42"}, "Content-Type": []string{"application/x-git-receive-pack-request"}}
	if got := sendRequest(t, server, http.MethodPost, "/git/Acme/Notes.git/git-receive-pack", "https://host.example", headers, "x").Code; got != http.StatusForbidden {
		t.Fatalf("read-only repo allowed push: %d", got)
	}
	headers.Set("Content-Type", "application/json")
	if got := sendRequest(t, server, http.MethodPost, "/git/Acme/Notes.git/git-upload-pack", "https://host.example", headers, "x").Code; got != http.StatusUnsupportedMediaType {
		t.Fatalf("wrong request content type accepted: %d", got)
	}
	if got := sendRequest(t, server, http.MethodPost, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", headers, "").Code; got != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method accepted: %d", got)
	}
}

func TestPreflightAllowlist(t *testing.T) {
	server := testServer(t, func(*http.Request) (*http.Response, error) { t.Fatal("preflight contacted upstream"); return nil, nil })
	headers := http.Header{"Access-Control-Request-Method": []string{"GET"}, "Access-Control-Request-Headers": []string{"Authorization, X-Proprium-Repository-Id"}}
	response := sendRequest(t, server, http.MethodOptions, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", headers, "")
	if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Origin") != "https://host.example" {
		t.Fatalf("valid preflight rejected: %d", response.Code)
	}
	headers.Set("Access-Control-Request-Headers", "Authorization, X-Evil")
	response = sendRequest(t, server, http.MethodOptions, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", headers, "")
	if response.Code != http.StatusForbidden {
		t.Fatalf("unsafe preflight accepted: %d", response.Code)
	}
}

func TestSmartHTTPRepositoryIdentityAndUpstreamFailureDoNotLeakCredentials(t *testing.T) {
	calls := 0
	server := testServer(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return jsonResponseForTest(200, `{"id":99,"full_name":"Acme/Notes","permissions":{"pull":true}}`, nil), nil
		}
		return nil, errors.New("authorization: secret")
	})
	headers := http.Header{"Authorization": []string{"Bearer very-secret-token"}, "X-Proprium-Repository-Id": []string{"42"}}
	response := sendRequest(t, server, http.MethodGet, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", headers, "")
	if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "very-secret") || strings.Contains(response.Body.String(), "authorization") {
		t.Fatalf("identity error leaked: %d %s", response.Code, response.Body.String())
	}
	server.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			return jsonResponseForTest(200, repoMetadata("pull"), nil), nil
		}
		return nil, context.DeadlineExceeded
	})}
	response = sendRequest(t, server, http.MethodGet, "/git/Acme/Notes.git/info/refs?service=git-upload-pack", "https://host.example", headers, "")
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("upstream error leaked: %d %s", response.Code, response.Body.String())
	}
}

func TestCancelledUpstreamUsesRequestContext(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	server := testServer(t, func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.Host, "api.github.com") {
			return jsonResponseForTest(200, repoMetadata("pull"), nil), nil
		}
		close(started)
		<-r.Context().Done()
		close(cancelled)
		return nil, r.Context().Err()
	})
	request := httptest.NewRequest(http.MethodGet, "https://gateway.example/git/Acme/Notes.git/info/refs?service=git-upload-pack", nil)
	request.Header.Set("Origin", "https://host.example")
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("X-Proprium-Repository-Id", "42")
	ctx, cancel := context.WithCancel(request.Context())
	request = request.WithContext(ctx)
	finished := make(chan struct{})
	go func() {
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		close(finished)
	}()
	<-started
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream request did not observe cancellation")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("handler did not finish after cancellation")
	}
}

func TestBoundedReaderAndGitResponseLimit(t *testing.T) {
	if _, err := readLimited(context.Background(), nil, strings.NewReader(strings.Repeat("x", maxOAuthRequestBytes+1)), maxOAuthRequestBytes); !errors.Is(err, errTooLarge) {
		t.Fatalf("oversized OAuth request not rejected: %v", err)
	}
	target := httptest.NewRecorder()
	copyGitResponse(target, strings.NewReader(strings.Repeat("g", maxSmartHTTPBytes+32)), maxSmartHTTPBytes)
	if int64(target.Body.Len()) != maxSmartHTTPBytes {
		t.Fatalf("Git stream cap violated: %d", target.Body.Len())
	}
}
