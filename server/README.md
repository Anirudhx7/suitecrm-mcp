# suitecrm-mcp-gateway

Open-source MCP (Model Context Protocol) gateway for SuiteCRM. Connects Claude Desktop, Claude Code, and any MCP client to SuiteCRM over SSE.

- 24 CRM tools: search, get, create, update, relationships, attachments, dry-run previews
- OAuth2/OIDC auth (Auth0, Azure AD, any OIDC provider) - gateway-issued personal API keys
- Multi-entity support: one gateway fronts multiple SuiteCRM instances
- ACL enforcement, Redis-persisted sessions, per-user rate limiting, circuit breaker
- Prometheus/Grafana/Loki observability stack included

This package is the gateway server itself. It runs on your infrastructure next to SuiteCRM - it is not a stdio server you launch from a client config. Use the one-command installer for production deployment.

## Install

Recommended (full installer with systemd, HTTPS, multi-entity):

See the [setup guide](https://github.com/Anirudhx7/suitecrm-mcp/blob/main/docs/setup-guide.md) and run `install.py` from the repository.

Manual (this package):

```bash
npm install suitecrm-mcp-gateway
node node_modules/suitecrm-mcp-gateway/index.mjs
```

Required environment variables: `SUITECRM_ENDPOINT`, `SUITECRM_PREFIX`, `PORT`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`. See [.env.example](https://github.com/Anirudhx7/suitecrm-mcp/blob/main/.env.example) for the full list.

## Links

- Website: https://anirudh.social/suitecrm-mcp/
- Documentation: https://anirudh.social/suitecrm-mcp/docs.html
- GitHub: https://github.com/Anirudhx7/suitecrm-mcp
- License: MIT
