package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sort"
)

const (
	currentMCPVersion   = "2026-07-28"
	legacyMCPVersion    = "2025-11-25"
	maxMCPResponseBytes = 2 << 20
)

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}
type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}
type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type mcpEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *mcpError       `json:"error,omitempty"`
}
type toolResult struct {
	Content           []map[string]string `json:"content"`
	StructuredContent map[string]any      `json:"structuredContent"`
	IsError           bool                `json:"isError,omitempty"`
}

var liveTools = map[string]mcpTool{
    "repositories_list": {Name: "repositories_list", Description: "List local repositories visible to the active Browser Host.", InputSchema: objectSchema(nil,nil)},
    "repository_info": {Name: "repository_info", Description: "Inspect a repository by immutable GitHub ID.", InputSchema: repoSchema(nil,nil)},
    "files_list": {Name: "files_list", Description: "List files in the selected repository.", InputSchema: repoSchema(nil,nil)},
    "file_read": {Name: "file_read", Description: "Read text from the selected repository.", InputSchema: repoSchema(map[string]any{"path":stringSchema("Repository relative file path")},[]string{"path"})},
    "git_status": {Name: "git_status", Description: "Inspect the selected repository local Git status.", InputSchema: repoSchema(nil,nil)},
    "git_log": {Name: "git_log", Description: "Inspect the selected repository local Git history.", InputSchema: repoSchema(map[string]any{"limit":map[string]any{"type":"integer","minimum":1,"maximum":100}},nil)},
    "plugin_call": {Name: "plugin_call", Description: "Call the Browser Host plugin for the selected repository.", InputSchema: repoSchema(map[string]any{"pluginId":stringSchema("Plugin identifier"),"operation":stringSchema("Plugin operation"),"input":map[string]any{"description":"JSON input"}},[]string{"pluginId","operation"})},
    "proposal_submit": {Name: "proposal_submit", Description: "Submit a file-change proposal for explicit Browser Host review.", InputSchema: repoSchema(map[string]any{"title":map[string]any{"type":"string","maxLength":200},"changes":map[string]any{"type":"array","minItems":1,"maxItems":32,"items":objectSchema(map[string]any{"path":stringSchema("Repository relative file path"),"content":stringSchema("Proposed UTF-8 text"),"expectedRevision":map[string]any{"anyOf":[]map[string]string{{"type":"string"},{"type":"null"}}}},[]string{"path","content","expectedRevision"})}},[]string{"title","changes"})},
}
func repoSchema(properties map[string]any, required []string) map[string]any {
    if properties == nil { properties = map[string]any{} }
    properties["repository_id"] = map[string]any{"type":"integer","minimum":1,"description":"Immutable GitHub repository ID"}
    properties["branch"] = map[string]any{"type":"string","description":"Optional branch; required when the repository has multiple known branches"}
    return objectSchema(properties,append([]string{"repository_id"},required...))
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}
func objectSchema(properties map[string]any, required []string) map[string]any {
	p := properties
	if p == nil {
		p = map[string]any{}
	}
	result := map[string]any{"type": "object", "properties": p, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

func (r *LiveRegistry) MCPHandler() http.Handler { return http.HandlerFunc(r.serveMCP) }
func (r *LiveRegistry) serveMCP(w http.ResponseWriter, req *http.Request) {
	if req.URL.RawQuery != "" {
		mcpHTTPError(w, http.StatusBadRequest, json.RawMessage("null"), -32600, "Query parameters are not allowed")
		return
	}
	if !r.validHost(req.Host) {
		mcpHTTPError(w, http.StatusForbidden, json.RawMessage("null"), -32000, "Host not allowed")
		return
	}
	if origin := req.Header.Get("Origin"); origin != "" {
		if origin != r.config.HostOrigin || !validConfiguredOrigin(r.config.HostOrigin) {
			mcpHTTPError(w, http.StatusForbidden, json.RawMessage("null"), -32000, "Origin not allowed")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", r.config.HostOrigin)
		w.Header().Set("Vary", "Origin")
	}
	if req.Method == http.MethodOptions {
		if req.Header.Get("Origin") != r.config.HostOrigin || req.Header.Get("Access-Control-Request-Method") != http.MethodPost {
			mcpHTTPError(w, http.StatusForbidden, json.RawMessage("null"), -32000, "Preflight not allowed")
			return
		}
		for _, header := range strings.Split(strings.ToLower(req.Header.Get("Access-Control-Request-Headers")), ",") {
			header = strings.TrimSpace(header)
			if header != "" && !contains([]string{"accept", "authorization", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"}, header) {
				mcpHTTPError(w, http.StatusForbidden, json.RawMessage("null"), -32000, "Preflight not allowed")
				return
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", http.MethodPost)
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if req.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost+", OPTIONS")
		mcpHTTPError(w, http.StatusMethodNotAllowed, json.RawMessage("null"), -32000, "Method not allowed")
		return
	}
		if !acceptsMCP(req.Header.Get("Accept")) {
		mcpHTTPError(w, http.StatusNotAcceptable, json.RawMessage("null"), -32000, "Accept must include application/json and text/event-stream")
		return
	}
	if !strings.HasPrefix(strings.ToLower(req.Header.Get("Content-Type")), "application/json") {
		mcpHTTPError(w, http.StatusUnsupportedMediaType, json.RawMessage("null"), -32600, "Content-Type must be application/json")
		return
	}
	body := http.MaxBytesReader(w, req.Body, maxLiveBodyBytes)
	dec := json.NewDecoder(body)
	dec.UseNumber()
	var message mcpRequest
	if err := dec.Decode(&message); err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "too large") {
			status = http.StatusRequestEntityTooLarge
		}
		mcpHTTPError(w, status, json.RawMessage("null"), -32700, "Invalid JSON-RPC message")
		return
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		mcpHTTPError(w, http.StatusBadRequest, message.ID, -32600, "Exactly one JSON-RPC message is required")
		return
	}
	if message.JSONRPC != "2.0" || message.Method == "" || !validRPCID(message.ID) {
		mcpHTTPError(w, http.StatusBadRequest, message.ID, -32600, "Invalid JSON-RPC request")
		return
	}
	isNotification := len(message.ID) == 0 || bytes.Equal(bytes.TrimSpace(message.ID), []byte("null"))
	if isNotification {
		message.ID = nil
	}
	if err := validateProtocol(req.Header, message); err != nil {
		mcpHTTPError(w, http.StatusBadRequest, message.ID, -32020, err.Error())
		return
	}
	if err := validateMetadataHeaders(req.Header, message); err != nil {
		mcpHTTPError(w, http.StatusBadRequest, message.ID, -32020, err.Error())
		return
	}
	if req.Header.Get("MCP-Protocol-Version") == currentMCPVersion {
		w.Header().Set("MCP-Protocol-Version", currentMCPVersion)
	}
	if isNotification {
		switch message.Method {
		case "notifications/initialized":
			mcpHTTPNoContent(w, http.StatusAccepted)
			return
		case "notifications/cancelled":
			// HTTP cancellation propagates via dispatch; external JSON-RPC IDs are not shared between clients
			mcpHTTPNoContent(w, http.StatusAccepted)
			return
		default:
			mcpHTTPNoContent(w, http.StatusAccepted)
			return
		}
	}
	if message.Method == "initialize" {
		r.serveInitialize(w, message)
		return
	}
	switch message.Method {
	case "server/discover":
		if req.Header.Get("MCP-Protocol-Version") != currentMCPVersion || !emptyOrObject(message.Params) {
			mcpHTTPError(w, http.StatusBadRequest, message.ID, -32602, "server/discover requires current MCP protocol metadata")
			return
		}
		writeMCP(w, http.StatusOK, mcpEnvelope{JSONRPC: "2.0", ID: message.ID, Result: map[string]any{
			"supportedVersions": []string{currentMCPVersion},
			"capabilities":      map[string]any{"tools": map[string]any{"listChanged": false}},
			"ttlMs":             0, "cacheScope": "private",
			"instructions": "Tools operate on the currently connected Browser Host. Changes require explicit Host review.",
		}})
	case "ping":
		writeMCP(w, http.StatusOK, mcpEnvelope{JSONRPC: "2.0", ID: message.ID, Result: map[string]any{}})
	case "tools/list":
		r.serveToolList(w, message)
	case "tools/call":
		r.serveToolCall(w, req, message)
	default:
		mcpHTTPError(w, http.StatusNotFound, message.ID, -32601, "Method not found")
	}
}

func acceptsMCP(value string) bool {
	foundJSON, foundSSE := false, false
	for _, entry := range strings.Split(value, ",") {
		mime := strings.TrimSpace(strings.SplitN(entry, ";", 2)[0])
		if mime == "application/json" {
			foundJSON = true
		}
		if mime == "text/event-stream" {
			foundSSE = true
		}
	}
	return foundJSON && foundSSE
}
func validRPCID(raw json.RawMessage) bool {
	if len(raw) > 256 {
		return false
	}
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return true
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&v) != nil {
		return false
	}
	switch v.(type) {
	case string, json.Number:
		return true
	default:
		return false
	}
}
func rpcIDKey(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	return string(bytes.TrimSpace(raw))
}

func validateProtocol(headers http.Header, message mcpRequest) error {
	if message.Method == "initialize" {
		return nil
	}
	version := headers.Get("MCP-Protocol-Version")
	if (message.Method == "notifications/cancelled" || message.Method == "notifications/initialized") && version == "" {
		return nil
	}
	if version == currentMCPVersion {
		var root map[string]any
		if err := json.Unmarshal(message.Params, &root); err != nil {
			return errors.New("params must be an object")
		}
		meta, _ := root["_meta"].(map[string]any)
		bodyVersion, _ := meta["io.modelcontextprotocol/protocolVersion"].(string)
		if bodyVersion != currentMCPVersion {
			return errors.New("MCP-Protocol-Version does not match request metadata")
		}
		return nil
	}
	if version == legacyMCPVersion {
		return nil
	}
	if version == "" {
		return errors.New("MCP-Protocol-Version is required")
	}
	return errors.New("unsupported MCP protocol version")
}
func decodeMCPHeader(value string) (string, error) {
	if !strings.HasPrefix(value, "=?base64?") {
		if !headerASCII(value) {
			return "", errors.New("header value must use the base64 sentinel encoding")
		}
		return value, nil
	}
	if !strings.HasSuffix(value, "?=") {
		return "", errors.New("invalid base64 sentinel encoding")
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(value, "=?base64?"), "?=")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", errors.New("invalid base64 sentinel encoding")
	}
	return string(decoded), nil
}
func headerASCII(value string) bool {
	if strings.HasPrefix(value, " ") || strings.HasSuffix(value, " ") || strings.HasPrefix(value, "\t") || strings.HasSuffix(value, "\t") {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r > 0x7e {
			return false
		}
	}
	return true
}
func validateMetadataHeaders(headers http.Header, message mcpRequest) error {
	version := headers.Get("MCP-Protocol-Version")
	if version != currentMCPVersion {
		return nil
	}
	method, err := decodeMCPHeader(headers.Get("Mcp-Method"))
	if err != nil || method != message.Method {
		return errors.New("Mcp-Method does not match request body")
	}
	if message.Method == "tools/call" {
		var params struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(message.Params, &params) != nil || params.Name == "" {
			return errors.New("tools/call name is required")
		}
		name, err := decodeMCPHeader(headers.Get("Mcp-Name"))
		if err != nil || name != params.Name {
			return errors.New("Mcp-Name does not match request body")
		}
	}
	return nil
}

func (r *LiveRegistry) serveInitialize(w http.ResponseWriter, message mcpRequest) {
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
		ClientInfo      any    `json:"clientInfo"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.ProtocolVersion != legacyMCPVersion {
		mcpHTTPError(w, http.StatusBadRequest, message.ID, -32602, "Only legacy MCP initialize at 2025-11-25 is supported")
		return
	}
	result := map[string]any{"protocolVersion": legacyMCPVersion, "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}, "serverInfo": map[string]string{"name": "proprium-live-workspace", "version": "1.0.0"}, "instructions": "Tools operate on the workspace currently open in the Proprium Browser Host. File changes are proposals for explicit Host review."}
	writeMCP(w, http.StatusOK, mcpEnvelope{JSONRPC: "2.0", ID: message.ID, Result: result})
}
func (r *LiveRegistry) serveToolList(w http.ResponseWriter, message mcpRequest) {
    if !emptyOrObject(message.Params) {
        mcpHTTPError(w,http.StatusBadRequest,message.ID,-32602,"tools/list params must be an object")
        return
    }
    names := make([]string,0,len(liveTools))
    for name := range liveTools { names = append(names,name) }
    sort.Strings(names)
    tools := make([]mcpTool,0,len(names))
    for _,name := range names { tools = append(tools,liveTools[name]) }
    writeMCP(w,http.StatusOK,mcpEnvelope{JSONRPC:"2.0",ID:message.ID,Result:map[string]any{"tools":tools,"ttlMs":0,"cacheScope":"private"}})
}
func emptyOrObject(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var value map[string]json.RawMessage
	return json.Unmarshal(raw, &value) == nil && value != nil
}

func (r *LiveRegistry) serveToolCall(w http.ResponseWriter, req *http.Request, message mcpRequest) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(message.Params, &params) != nil || params.Name == "" {
		mcpHTTPError(w, http.StatusBadRequest, message.ID, -32602, "tools/call requires a tool name")
		return
	}
	definition, known := liveTools[params.Name]
	if !known {
		mcpHTTPError(w, http.StatusNotFound, message.ID, -32601, "Tool not found")
		return
	}
	if len(params.Arguments) == 0 {
		params.Arguments = json.RawMessage(`{}`)
	}
	if err := validateArguments(definition.InputSchema, params.Arguments); err != nil {
		mcpHTTPError(w, http.StatusBadRequest, message.ID, -32602, err.Error())
		return
	}
	response, err := r.dispatch(req, params.Name, params.Arguments)
	if err != nil {
		if errors.Is(err, errCapacity) {
			mcpHTTPError(w, http.StatusServiceUnavailable, message.ID, -32000, "Workspace request capacity reached")
			return
		}
		mcpHTTPError(w, http.StatusInternalServerError, message.ID, -32603, "Request could not be dispatched")
		return
	}
	switch response.status {
	case "unavailable":
		mcpHTTPError(w, http.StatusServiceUnavailable, message.ID, -32000, "Workspace unavailable")
		return
	case "cancelled":
		mcpHTTPError(w, http.StatusOK, message.ID, -32800, "Workspace cancelled the request")
		return
	case "timeout":
		mcpHTTPError(w, http.StatusGatewayTimeout, message.ID, -32001, "Workspace request timed out")
		return
	}
	if response.status == "failed" {
		text := response.err
		if text == "" {
			text = "Workspace operation failed"
		}
		writeMCP(w, http.StatusOK, mcpEnvelope{JSONRPC: "2.0", ID: message.ID, Result: toolErrorResult(text)})
		return
	}
	if response.status != "completed" {
		mcpHTTPError(w, http.StatusBadGateway, message.ID, -32000, "Workspace returned an invalid response")
		return
	}
	var decoded any
	if err := json.Unmarshal(response.result, &decoded); err != nil {
		mcpHTTPError(w, http.StatusBadGateway, message.ID, -32000, "Workspace returned invalid JSON")
		return
	}
	text := string(response.result)
	result := toolResult{Content: []map[string]string{{"type": "text", "text": text}}, StructuredContent: map[string]any{"data": decoded}}
	writeMCP(w, http.StatusOK, mcpEnvelope{JSONRPC: "2.0", ID: message.ID, Result: result})
}
func toolErrorResult(text string) toolResult {
	if len(text) > 1024 {
		text = text[:1024]
	}
	payload := map[string]any{"error": text}
	encoded, _ := json.Marshal(payload)
	return toolResult{Content: []map[string]string{{"type": "text", "text": string(encoded)}}, StructuredContent: payload, IsError: true}
}

func validateArguments(schema map[string]any, raw json.RawMessage) error {
	var args map[string]json.RawMessage
	if json.Unmarshal(raw, &args) != nil || args == nil {
		return errors.New("tool arguments must be an object")
	}
	properties, _ := schema["properties"].(map[string]any)
	for key := range args {
		if _, ok := properties[key]; !ok {
			return fmt.Errorf("unexpected tool argument: %s", key)
		}
	}
	if required, ok := schema["required"].([]string); ok {
		for _, key := range required {
			if _, ok := args[key]; !ok {
				return fmt.Errorf("missing required tool argument: %s", key)
			}
		}
	} else if required, ok := schema["required"].([]any); ok {
		for _, item := range required {
			key, _ := item.(string)
			if _, ok := args[key]; !ok {
				return fmt.Errorf("missing required tool argument: %s", key)
			}
		}
	}
	for key, rawValue := range args {
		field, _ := properties[key].(map[string]any)
		kind, _ := field["type"].(string)
		switch kind {
		case "string":
			var v string
			if json.Unmarshal(rawValue, &v) != nil {
				return fmt.Errorf("tool argument %s must be a string", key)
			}
			if v == "" && contains(requiredKeys(schema), key) {
				return fmt.Errorf("tool argument %s must not be empty", key)
			}
			if max, ok := field["maxLength"].(int); ok && len(v) > max {
				return fmt.Errorf("tool argument %s exceeds %d bytes", key, max)
			}
		case "integer":
			var n int
			if json.Unmarshal(rawValue, &n) != nil {
				return fmt.Errorf("tool argument %s must be an integer", key)
			}
			if min, ok := field["minimum"].(int); ok && n < min {
				return fmt.Errorf("tool argument %s is below minimum", key)
			}
			if max, ok := field["maximum"].(int); ok && n > max {
				return fmt.Errorf("tool argument %s exceeds maximum", key)
			}
		case "array":
			var values []json.RawMessage
			if json.Unmarshal(rawValue, &values) != nil {
				return fmt.Errorf("tool argument %s must be an array", key)
			}
			if min, ok := field["minItems"].(int); ok && len(values) < min {
				return fmt.Errorf("tool argument %s requires at least %d items", key, min)
			}
			if max, ok := field["maxItems"].(int); ok && len(values) > max {
				return fmt.Errorf("tool argument %s allows at most %d items", key, max)
			}
			if key == "changes" {
				totalBytes := 0
				for i, item := range values {
					var change map[string]json.RawMessage
					if json.Unmarshal(item, &change) != nil {
						return fmt.Errorf("changes[%d] must be an object", i)
					}
					for _, required := range []string{"path", "content", "expectedRevision"} {
						if _, ok := change[required]; !ok {
							return fmt.Errorf("changes[%d].%s is required", i, required)
						}
					}
					for _, name := range []string{"path", "content"} {
						var str string
						if json.Unmarshal(change[name], &str) != nil {
							return fmt.Errorf("changes[%d].%s must be a string", i, name)
						}
						if name == "content" {
							totalBytes += len(str)
						}
					}
					var revision *string
					if string(bytes.TrimSpace(change["expectedRevision"])) != "null" && json.Unmarshal(change["expectedRevision"], &revision) != nil {
						return fmt.Errorf("changes[%d].expectedRevision must be a string or null", i)
					}
				}
				if totalBytes > 512*1024 {
					return errors.New("proposal content exceeds the 512 KiB limit")
				}
			}
		default:
		}
	}
	return nil
}
func requiredKeys(schema map[string]any) []string {
	switch v := schema["required"].(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func mcpHTTPNoContent(w http.ResponseWriter, status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
}
func mcpHTTPError(w http.ResponseWriter, status int, id json.RawMessage, code int, message string) {
	writeMCP(w, status, mcpEnvelope{JSONRPC: "2.0", ID: id, Error: &mcpError{Code: code, Message: message}})
}
func writeMCP(w http.ResponseWriter, status int, message mcpEnvelope) {
	if !validRPCID(message.ID) {
		message.ID = json.RawMessage("null")
	}
	if message.Result != nil && w.Header().Get("MCP-Protocol-Version") == currentMCPVersion {
		encoded, err := json.Marshal(message.Result)
		var result map[string]json.RawMessage
		if err == nil && json.Unmarshal(encoded, &result) == nil && result != nil {
			result["resultType"] = json.RawMessage(`"complete"`)
			result["_meta"], _ = json.Marshal(map[string]any{"io.modelcontextprotocol/serverInfo": map[string]string{"name": "proprium-gateway", "version": version}})
			message.Result = result
		}
	}
	data, err := json.Marshal(message)
	if err != nil || len(data) > maxMCPResponseBytes {
		status = http.StatusBadGateway
		data = []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"MCP response exceeded the gateway limit"}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(data, '\n'))
}
