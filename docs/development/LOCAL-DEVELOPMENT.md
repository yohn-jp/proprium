# Local Proprium development

The static Browser Host needs Node.js and pnpm according to the root package and lockfile. The Gateway needs Go 1.27.3. No container, database or root service is required.

## Browser Host

~~~sh
pnpm install --frozen-lockfile
pnpm dev:browser --host 127.0.0.1 --port 5173
~~~

Open `http://127.0.0.1:5173`. The Host uses browser storage for local workspace state. Editing, local Git and locally available WASM plugins work without a Gateway.

## Local Gateway

In another terminal, from the repository root, build and run the Gateway using loopback origins that match the Host and Gateway exactly:

~~~sh
cd gateway
export PROPRIUM_LISTEN_ADDR=127.0.0.1:8080
export PROPRIUM_HOST_ORIGIN=http://127.0.0.1:5173
export PROPRIUM_PUBLIC_URL=http://127.0.0.1:8080
export GITHUB_CLIENT_ID=YOUR_GITHUB_OAUTH_APP_CLIENT_ID
export PROPRIUM_OWNER_KEY="$(openssl rand -base64 48)"
go run . serve --listen 127.0.0.1:8080
~~~

For device authorization, configure the OAuth App for Device Flow. The client ID is required at Gateway startup and is public; there is no client secret in the binary or Host. Live MCP also requires a loopback `PROPRIUM_PUBLIC_URL` even in development. Do not use a real GitHub token as the MCP owner key. Keep the owner key in the Gateway process environment only and enter it in the Host's optional Live MCP settings when testing that feature.

Set `VITE_PROPRIUM_GATEWAY_URL=http://127.0.0.1:8080` before starting the Host if using a custom Gateway URL. The Host sends GitHub REST requests directly to GitHub when supported; the Gateway is needed for Device Flow and Smart HTTP fallback. Without the Gateway, local file editing, local commits and plugin execution continue.

The development configuration permits plain HTTP only on loopback. For public or shared use, run the Gateway behind HTTPS and use exact HTTPS origins. See [Gateway settings and Tunnel deployment](../deployment/GATEWAY.md).

## Checks

~~~sh
cd gateway
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -o /tmp/proprium-gateway .
cd ..
pnpm typecheck:browser
pnpm test:browser:unit
pnpm test:browser:e2e
pnpm test:browser:static:e2e
pnpm test:browser:adapters
pnpm build:browser
~~~

`pnpm test:browser:e2e` starts the real Go Gateway from `gateway/` alongside the Vite Host and runs the Live MCP acceptance scenarios in Chromium and mobile WebKit. It does not need live GitHub credentials for those Gateway/MCP scenarios. Tests configured for live GitHub sync use a dedicated disposable repository and the documented `PROPRIUM_E2E_GITHUB_*` variables. A local Gateway proves the browser integration and loopback transport, not public Tunnel behavior. Report a real Cloudflare Tunnel, live GitHub account, physical mobile device or production Host check as `NOT_CHECKED` until that environment is actually exercised.

See [Contributing](../../CONTRIBUTING.md), [Gateway operations](../deployment/GATEWAY.md), and [Cloudflare static Host deployment](../deployment/CLOUDFLARE.md).
