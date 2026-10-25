package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type blockedReadBody struct {
	closed chan struct{}
	once   sync.Once
}

func (b *blockedReadBody) Read([]byte) (int, error) { <-b.closed; return 0, errors.New("closed") }
func (b *blockedReadBody) Close() error             { b.once.Do(func() { close(b.closed) }); return nil }

type deadlineTestWriter struct {
	header   http.Header
	deadline time.Time
	status   int
}

func (w *deadlineTestWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}
func (w *deadlineTestWriter) WriteHeader(status int)         { w.status = status }
func (w *deadlineTestWriter) Write(body []byte) (int, error) { return len(body), nil }
func (w *deadlineTestWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func TestIncomingBodyIsClosedAtRequestDeadline(t *testing.T) {
	config := testConfig()
	config.UpstreamTimeout = time.Second
	server, err := NewServer(config)
	if err != nil {
		t.Fatal(err)
	}
	body := &blockedReadBody{closed: make(chan struct{})}
	request := httptest.NewRequest(http.MethodPost, "https://gateway.example/oauth/device/code", nil)
	request.Body = body
	request.ContentLength = -1
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://host.example")
	response := httptest.NewRecorder()
	finished := make(chan struct{})
	go func() { server.Handler().ServeHTTP(response, request); close(finished) }()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("blocked body read survived its request deadline")
	}
	select {
	case <-body.closed:
	default:
		t.Fatal("request timeout did not close the body reader")
	}
}

func TestResponseWriterUsesRequestDeadlineAndSSEWriteLimit(t *testing.T) {
	requestDeadline := time.Now().Add(5 * time.Second)
	ctx, cancel := context.WithDeadline(context.Background(), requestDeadline)
	defer cancel()
	response := &deadlineTestWriter{}
	writer := &deadlineWriter{ResponseWriter: response, timeout: time.Minute, ctx: ctx}
	if _, err := writer.Write([]byte("bounded")); err != nil {
		t.Fatal(err)
	}
	if delta := response.deadline.Sub(requestDeadline); delta > time.Millisecond || delta < -time.Millisecond {
		t.Fatalf("write deadline moved away from request deadline: %v", response.deadline)
	}

	response = &deadlineTestWriter{}
	writer = &deadlineWriter{ResponseWriter: response, timeout: 250 * time.Millisecond, ctx: context.Background()}
	start := time.Now()
	if _, err := writer.Write([]byte("event")); err != nil {
		t.Fatal(err)
	}
	if remaining := time.Until(response.deadline); remaining <= 0 || remaining > 250*time.Millisecond {
		t.Fatalf("SSE event write deadline is not bounded: %v after %v", remaining, time.Since(start))
	}
}

func TestLimitedListenerReleasesSlotsOnCloseAndListenerShutdown(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	limited := newLimitListener(listener, 1)
	accepted := make(chan net.Conn, 1)
	acceptErr := make(chan error, 1)
	go func() {
		conn, err := limited.Accept()
		if err != nil {
			acceptErr <- err
			return
		}
		accepted <- conn
	}()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var conn net.Conn
	select {
	case conn = <-accepted:
	case err := <-acceptErr:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("connection wasn't accepted")
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	if err := limited.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := limited.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("closed listener returned unexpected error: %v", err)
	}
}

func TestIdleLiveSSEDoesNotExpireAndEventWriteIsDeadlineBounded(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config := testConfig()
	config.PublicURL = "http://" + listener.Addr().String()
	config.UpstreamTimeout = time.Second
	server, err := NewServer(config)
	if err != nil {
		t.Fatal(err)
	}
	server.mux.HandleFunc("GET /live/sessions/test/events", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(1200 * time.Millisecond)
		_, _ = io.WriteString(w, "event: ready\n\n")
	})
	httpServer := &http.Server{Handler: server.Handler(), ReadTimeout: time.Second, ReadHeaderTimeout: time.Second}
	go func() { _ = httpServer.Serve(listener) }()
	defer func() { server.Close(); _ = httpServer.Close() }()
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(config.PublicURL + "/live/sessions/test/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "event: ready\n\n" {
		t.Fatalf("idle SSE was interrupted or event lost: %d %q", response.StatusCode, body)
	}
}
