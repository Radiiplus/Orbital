# Orbital Orbkit Module Set (`orbital/orbkit/mod`)

Shared-config module toolkit for:

- Devnet-only wallet funding
- Multi-network build + deploy (`devnet`, `testnet`, `mainnet`)
- Multi-network wallet balance retrieval (`devnet`, `testnet`, `mainnet`)
- Rust/CKB contract structure and script-functionality analysis

## Files

- `mod/config.json` shared config
- `mod/genesis.json` known devnet genesis addresses list
- `mod/common.mjs` shared helpers (config/rpc/process/path)
- `mod/setup` devnet bootstrap module (auto-start devnet when needed)
- `mod/fund.mjs` devnet-only funding module
- `mod/balance-worker.mjs` backend-facing balance request worker
- `mod/buildeploy.mjs` build + deploy module for all chain types
- `mod/balance.mjs` wallet balance module for all chain types
- `mod/structure.mjs` Rust contract tree, Cargo metadata, module graph, and CKB script analyzer
- `../orbital.config.js` orbkit-side contract config source

## Install

From `orbital/orbkit/`:

```bash
npm install
```

## Scaffold A New Workspace (CLI)

From `orbital/orbkit/`:

```bash
node ./bin/orbital.js init <project-name>
```

Alias form (your requested style):

```bash
node ./bin/orbital.js start orbital <project-name>
```

Options:

- `--dir <targetDir>` create inside a different parent directory
- `--force` allow scaffolding into an existing non-empty target directory

What gets created:

- `<project-name>/package.json`
- `<project-name>/orbkit/orbital.config.js` (contract path/script use your project name)
- `<project-name>/orbkit/mod/*` runtime scripts and config
- `<project-name>/contract/<project-name>/`
- `<project-name>/deployment/`

If this package is published with a public name, you can run it with:

```bash
npx <published-package-name> init <project-name>
```

or:

```bash
npx <published-package-name> start orbital <project-name>
```

## Shared Config

Default config path: `mod/config.json`

Override with `--config <path>` in each script.
Relative paths in config are resolved from the config file location.

## 0) Ensure Devnet Runtime (auto for devnet flows)

```bash
node mod/setup [--config mod/config.json] [--network devnet]
```

Behavior:
- If network is `devnet`, it checks local RPC and auto-starts OffCKB devnet when not running.
- If network is `testnet`/`mainnet`, it skips startup.

## 1) Fund Wallet (Devnet only)

```bash
node mod/fund.mjs <walletAddress> <amountInCKB> [--privkey 0x...] [--config mod/config.json]
```

Notes:
- This module only funds `devnet`.
- It validates that `config.networks.devnet.offckbNetwork` is `devnet`.
- Minimum amount is enforced at `62 CKB` to satisfy recipient output occupied capacity.
- Known devnet genesis addresses are loaded from `mod/genesis.json`.
- Funder private key resolution:
1. `--privkey`
2. env var named by `funder.privateKeyEnv` in config (default `FUNDER_PRIVKEY`)
3. `funder.defaultPrivateKey` in config

## 2) Build + Deploy (Devnet/Testnet/Mainnet)

```bash
node mod/buildeploy.mjs [--network devnet|testnet|mainnet] [--build|--no-build] [--config mod/config.json]
```

Required env:
- `CKB_PRIVATE_KEY` or `DEPLOYER_PRIVKEY`

This module:
- checks RPC reachability
- if network is `devnet`, auto-starts devnet first
- loads contract entries from orbkit-side `orbital.config.js` (not from `mod/config.json`)
- optionally builds Rust contracts (parallel build controlled by `deployment.concurrency`)
- deploys via `@offckb/cli`
- writes deployment config artifacts under deployment output directory

## 3) Get Wallet Balance (Devnet/Testnet/Mainnet)

```bash
node mod/balance.mjs <walletAddress> [--network devnet|testnet|mainnet] [--config mod/config.json]
```

Advanced CLI:

```bash
node mod/balance.mjs <walletAddress> --network testnet --scan-mode estimate --page-limit 20 --max-pages 1
```

Output includes:
- total/spendable/data-locked capacity
- shannons and CKB totals
- cell counts

Address/network rules:
- `devnet` and `testnet` expect `ckt1...`
- `mainnet` expects `ckb1...`

Optional tuning:
- `getWalletBalance({ ..., pageLimit, maxPages })` to control indexer pagination window and total pages.
- `getWalletBalance({ ..., scanMode: 'full' | 'estimate' })`:
  - `full`: scan all pages (default on devnet)
  - `estimate`: first pages only (default on testnet/mainnet) and returns `truncated` metadata

## 4) Analyze Contract Structure

```bash
node mod/structure.mjs <contractPath> [--config mod/config.json]
```

Output includes:
- total files and source files
- non-empty code line totals
- per-file Rust function names
- local Rust module/import and reverse `importedBy` relationships
- shared function names across files
- Cargo manifest summary
- CKB `ckb-std` behavior classification and detected features

## Package Scripts

From `orbital/orbkit/`:

```bash
npm run dev
npm run devnet:setup
npm run orbkit
npm run balance:worker
npm run fund:devnet -- <walletAddress> <amountInCKB>
npm run balance -- <walletAddress> --network devnet
npm run build:deploy -- --network devnet --build
```

`npm run dev` and `npm run devnet:setup` both follow the same startup behavior:
- ping the configured devnet RPC endpoint
- if it is already responding, exit immediately
- if it is not responding, start devnet, keep pinging until RPC responds, then exit

`npm run orbkit` starts the unified orbkit runtime for the project, including balance lookups, funding, build/deploy, and structure-sync capabilities through one command.

Set `ORBKIT_API_KEY` in the workspace `.env` before starting the runtime. The backend GraphQL URL is baked into the runtime default and can be overridden with `ORBITAL_SERVER_GRAPHQL_URL` when needed.
