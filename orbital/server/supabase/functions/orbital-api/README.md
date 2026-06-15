# Orbital Supabase Function Backend

This is the Supabase Edge Function version of the Orbital backend. It lives inside `orbital/server` so it can be versioned with the traditional Fastify server, and it can run as the hosted backend without deploying Fastify.

## Route Coverage

The function has three route modes:

- `edge` / `edge-cache`: handled directly by the Supabase function from durable Firebase/Firestore state.
- `edge-command`: writes Firebase command documents that a local Orbkit runtime polls and executes.
- `orbkit-poll`: private endpoints used by Orbkit to register services, poll commands, and publish progress.

Use `GET /routes` to see the function's route map at runtime.

Handled directly:

- `GET /health`
- `GET /routes`
- `GET /contracts/config`
- `GET /projects/structure/latest`
- `GET /contracts/deployments/latest`
- `GET /orbkit/status`
- `GET /networks/devnet/status`
- `GET /session`
- `POST /graphql` for the subset used by the frontend auth and wallet flows
- `POST /contracts/build`
- `POST /contracts/deploy`
- `POST /contracts/deploy/simulate`
- `POST /wallets/devnet/fund`
- `POST /projects/structure/sync`
- `POST /projects/structure/live`
- `GET /projects/structure/stream`
- `POST /orbkit/reconnect`
- `POST /session/refresh`
- `POST /wallets/export/mnemonic`

The traditional Fastify server can still be run locally or deployed separately, but it is no longer required for the Supabase-hosted path.

## Required Secrets

Set these in Supabase:

```bash
supabase secrets set FIREBASE_PROJECT_ID=...
supabase secrets set FIREBASE_CLIENT_EMAIL=...
supabase secrets set FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Optional:

```bash
supabase secrets set ORBKIT_API_KEY=...
```

`ORBKIT_API_KEY` is only needed if you want a shared internal Orbkit key. The user-created helper API key also works.

## Local Serve

Create `orbital/server/supabase/functions/orbital-api/.env.local` locally with the same env vars, then run from `orbital/server`:

```bash
npm run supabase:function:serve
```

## Deploy

Run from `orbital/server`:

```bash
npm run supabase:function:deploy
```

The frontend can target this function by pointing REST and GraphQL calls at:

```text
https://<project-ref>.supabase.co/functions/v1/orbital-api
```

```text
VITE_API_URL=https://<project-ref>.supabase.co/functions/v1/orbital-api
VITE_GRAPHQL_URL=https://<project-ref>.supabase.co/functions/v1/orbital-api/graphql
```

## Orbkit Runtime

In the Orbkit workspace `.env`, set:

```env
ORBITAL_SUPABASE_FUNCTION_URL=https://<project-ref>.supabase.co/functions/v1/orbital-api
ORBKIT_BACKEND_MODE=firebase
ORBKIT_API_KEY=<helper-api-key-or-internal-key>
```

Then run:

```bash
npm run orbkit
```

When `ORBITAL_SUPABASE_FUNCTION_URL` is present, Orbkit uses the Firebase/Supabase command queue instead of the old GraphQL WebSocket transport.
