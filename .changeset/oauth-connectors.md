---
"@scp-dev/relay": minor
---

Connectors: the relay serves the remote MCP endpoint at `/mcp` with an OAuth 2.1 authorization server (resource metadata, dynamic registration and client ID metadata documents for public clients, S256 PKCE, consent with an org picker, 1 h access tokens with rotating refresh tokens) stored in the `OAUTH_KV` namespace. Clients are labelled `claude-ai`, `chatgpt` or `mcp-oauth` from their redirect host; API tokens and device credentials also work on `/mcp` as `mcp-remote`, and OAuth tokens are refused on `/v1/relay/*`. The Tokens and devices tab lists and revokes connectors. Deployments need the `RELAY_ORIGIN` var and an `OAUTH_KV` namespace.
