package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

// The SSE peer is a fixture; this exercises the real Gateway transport, not the Browser Host.
func TestMCPPendingTypedActionDisconnectAndCancellation(t *testing.T) {
	for _, mode := range []string{"disconnect", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newLiveFixture(t)
			session := f.createSession("host-A")
			_, reader, closeStream := f.openEvents(session)
			defer closeStream()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{
				"name": "plugin_call", "arguments": map[string]any{"repository_id": 123, "branch": "main", "pluginId": "proprium.narrative", "operation": "proprium.narrative.work.detect", "input": map[string]any{}},
			}})
			if err != nil {
				t.Fatal(err)
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.server.URL+"/mcp", bytes.NewReader(raw))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("MCP-Protocol-Version", legacyMCPVersion)
			type outcome struct {
				status int
				body   []byte
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					done <- outcome{err: err}
					return
				}
				defer resp.Body.Close()
				body, err := io.ReadAll(resp.Body)
				done <- outcome{status: resp.StatusCode, body: body, err: err}
			}()
			event := f.readEvent(reader)
			if event["tool"] != "plugin_call" {
				t.Fatalf("wrong tool: %v", event)
			}
			args, ok := event["arguments"].(map[string]any)
			if !ok || args["operation"] != "proprium.narrative.work.detect" {
				t.Fatalf("typed action not forwarded: %v", event)
			}
			if mode == "disconnect" {
				closeStream()
				select {
				case result := <-done:
					if result.err != nil || result.status != http.StatusServiceUnavailable {
						t.Fatalf("disconnect result: %+v %s", result, result.body)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("pending MCP call did not settle on disconnect")
				}
			} else {
				cancel()
				cancelled := f.readEvent(reader)
				if cancelled["requestId"] != event["requestId"] || cancelled["reason"] != "cancelled" {
					t.Fatalf("wrong cancellation: %v", cancelled)
				}
				select {
				case result := <-done:
					if result.err == nil {
						t.Fatalf("cancelled HTTP request unexpectedly completed: %+v", result)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("cancelled HTTP request did not settle")
				}
				status, _ := f.httpJSON("POST", "/live/sessions/"+session+"/responses", map[string]any{"requestId": event["requestId"], "workspaceId": "host-A", "generation": "generation-1", "status": "completed", "result": map[string]any{"late": true}})
				if status == http.StatusAccepted {
					t.Fatal("late response accepted after cancellation")
				}
			}
		})
	}
}
