package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxConcurrentRequests = 128
const maxConnections = 256
const maxMCPRequestTimeout = 65 * time.Second

var version = "dev"
var commit = "unknown"

var authLandingTemplate = template.Must(template.New("auth-landing").Parse(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gateway認証</title>
</head>
<body>
  <main>
    <h1>Gatewayの認証が完了しました</h1>
    <p>Cloudflare AccessでこのGatewayへのアクセスが許可されました。Propriumに戻り、接続操作を続けてください。</p>
    <p><a href="{{.HostOrigin}}">Propriumに戻る</a></p>
  </main>
</body>
</html>
`))

// Server is an in-memory HTTP gateway. It has no persistence layer.
type Server struct {
	config Config
	mux    *http.ServeMux
	client *http.Client
	active chan struct{}
	live   interface {
		MCPHandler() http.Handler
	}
	controlServer   *http.Server
	controlListener net.Listener
	controlPath     string
	controlInfo     os.FileInfo
}

func NewServer(config Config) (*Server, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyFromEnvironment
	transport.DisableKeepAlives = false
	transport.MaxIdleConns = 16
	transport.MaxIdleConnsPerHost = 4
	transport.MaxConnsPerHost = 8
	transport.ResponseHeaderTimeout = config.UpstreamTimeout
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ExpectContinueTimeout = time.Second
	client := &http.Client{
		Transport: transport,
		Timeout:   config.UpstreamTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("redirects are disabled")
		},
	}
	s := &Server{config: config, mux: http.NewServeMux(), client: client, active: make(chan struct{}, maxConcurrentRequests)}
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
	s.mux.HandleFunc("GET /auth", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if err := authLandingTemplate.Execute(w, struct{ HostOrigin string }{HostOrigin: s.config.HostOrigin}); err != nil {
			return
		}
	})
	s.mux.HandleFunc("/oauth/device/code", s.handleOAuth)
	s.mux.HandleFunc("/oauth/token", s.handleOAuth)
	s.mux.HandleFunc("/git/", s.handleGit)
	registerLiveRoutes(s)
	registerMCPRoute(s)
	return s, nil
}

func (s *Server) Handler() http.Handler {
	return s.limit(s.timeout(deadlineWriterHandler{next: s.hostGuard(s.mux), timeout: s.config.UpstreamTimeout}))
}

func isLiveEventsPath(path string) bool {
	return strings.HasPrefix(path, "/live/sessions/") && strings.HasSuffix(path, "/events")
}

func (s *Server) hostGuard(next http.Handler) http.Handler {
	expected := []string{s.config.ListenAddr}
	if s.config.PublicURL != "" {
		parsed, _ := url.Parse(s.config.PublicURL)
		expected = append(expected, parsed.Host)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed := false
		for _, host := range expected {
			if strings.EqualFold(r.Host, host) {
				allowed = true
				break
			}
		}
		if !allowed {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusMisdirectedRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Close invalidates ephemeral Live Workspace sessions before the HTTP server drains.
func (s *Server) Close() {
	if closer, ok := s.live.(interface{ Close() }); ok {
		closer.Close()
	}
}

func (s *Server) limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.active <- struct{}{}:
			defer func() { <-s.active }()
		case <-r.Context().Done():
			return
		default:
			http.Error(w, "gateway_busy", http.StatusServiceUnavailable)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) timeout(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestTimeout := s.config.UpstreamTimeout
		if r.URL.Path == "/mcp" {
			requestTimeout = maxMCPRequestTimeout
		}
		if isLiveEventsPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()
		if r.Body != nil {
			done := make(chan struct{})
			defer close(done)
			go func(body io.ReadCloser) {
				select {
				case <-ctx.Done():
					_ = body.Close()
				case <-done:
				}
			}(r.Body)
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type deadlineWriterHandler struct {
	next    http.Handler
	timeout time.Duration
}

func (h deadlineWriterHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.next.ServeHTTP(&deadlineWriter{ResponseWriter: w, timeout: h.timeout, ctx: r.Context(), eventStream: isLiveEventsPath(r.URL.Path)}, r)
}

type deadlineWriter struct {
	http.ResponseWriter
	timeout     time.Duration
	ctx         context.Context
	eventStream bool
}

func (w *deadlineWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *deadlineWriter) setDeadline() {
	deadline := time.Now().Add(w.timeout)
	if requestDeadline, ok := w.ctx.Deadline(); ok {
		deadline = requestDeadline
	}
	_ = http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}

func (w *deadlineWriter) WriteHeader(status int) {
	if !w.eventStream {
		w.setDeadline()
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *deadlineWriter) Write(body []byte) (int, error) {
	w.setDeadline()
	return w.ResponseWriter.Write(body)
}

func (w *deadlineWriter) Flush() {
	_ = w.FlushError()
}

func (w *deadlineWriter) FlushError() error {
	w.setDeadline()
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}

func bearer(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(header, "Bearer ")
	if token == "" || len(token) > 4096 {
		return "", false
	}
	for _, ch := range token {
		if ch < 0x21 || ch > 0x7e {
			return "", false
		}
	}
	return token, true
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Printf("proprium-gateway version=%s commit=%s\n", version, commit)
		return
	}
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		log.Print("usage: proprium-gateway serve [--listen host:port]")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := flags.String("listen", "", "TCP address to listen on")
	if err := flags.Parse(os.Args[2:]); err != nil {
		os.Exit(2)
	}
	config, err := LoadConfig()
	if *listen != "" {
		config.ListenAddr = *listen
	}
	if err == nil {
		err = config.Validate()
	}
	if err != nil {
		log.Printf("configuration error: %v", err)
		os.Exit(2)
	}
	gateway, err := NewServer(config)
	if err != nil {
		log.Printf("configuration error: %v", err)
		os.Exit(2)
	}
	listener, err := net.Listen("tcp", config.ListenAddr)
	if err != nil {
		log.Printf("listen error: %v", err)
		os.Exit(1)
	}
	if err := gateway.startControlSocket(); err != nil {
		_ = listener.Close()
		log.Printf("control socket error: %v", err)
		os.Exit(1)
	}
	httpServer := &http.Server{
		Handler:           gateway.Handler(),
		ReadTimeout:       config.UpstreamTimeout,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		WriteTimeout:      0, // Streaming Git and MCP SSE writes are bounded by request contexts.
		MaxHeaderBytes:    16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		gateway.Close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		gateway.shutdownControl(shutdownCtx)
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			_ = httpServer.Close()
		}
	}()
	log.Printf("Proprium Gateway listening on %s", listener.Addr())
	limited := newLimitListener(listener, maxConnections)
	if err := httpServer.Serve(limited); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("serve error: %v", err)
		os.Exit(1)
	}
	<-shutdownDone
}

// limitListener bounds accepted TCP connections, including keep-alive and SSE connections.
type limitListener struct {
	net.Listener
	slots chan struct{}
	done  chan struct{}
	once  sync.Once
}

func newLimitListener(listener net.Listener, maximum int) *limitListener {
	return &limitListener{Listener: listener, slots: make(chan struct{}, maximum), done: make(chan struct{})}
}

func (l *limitListener) Accept() (net.Conn, error) {
	select {
	case l.slots <- struct{}{}:
	case <-l.done:
		return nil, net.ErrClosed
	}
	connection, err := l.Listener.Accept()
	if err != nil {
		<-l.slots
		return nil, err
	}
	return &limitedConn{Conn: connection, release: func() { <-l.slots }}, nil
}

func (l *limitListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return l.Listener.Close()
}

type limitedConn struct {
	net.Conn
	release func()
	once    sync.Once
}

func (c *limitedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}
