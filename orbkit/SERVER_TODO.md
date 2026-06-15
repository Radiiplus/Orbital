# Orbkit Server Integration Notes

This document tracks the backend-facing contract that Orbkit depends on when it connects a local workspace to the Orbital hosted runtime.

## Authentication

Orbkit authenticates with the backend using an API key. HTTP requests and WebSocket/Supabase command traffic should include the key as a bearer token:

```text
Authorization: Bearer <api-key>
```

The API key may be the helper key created from the Orbital dashboard or the internal `ORBKIT_API_KEY` configured on the backend.

## Runtime Channels

Orbkit expects these backend-facing events to remain available across local and hosted transports:

- `devnetBalance`: reports balance updates for a wallet address after Orbkit scans the selected network.
- `buildRequest`: sends build, deploy, and simulation requests from the Orbital dashboard to the local runtime.

Both channels are transport-agnostic. Local development can use GraphQL WebSocket subscriptions, while the hosted Supabase/Firebase path can deliver the same commands through polling and command documents.

## Pending Backend Work

- Keep REST and GraphQL payloads aligned for build, deploy, funding, balance, and structure sync commands.
- Preserve bearer-token authentication on Orbkit-only endpoints.
- Return stable request IDs so frontend, backend, and Orbkit logs can be correlated across platforms.
