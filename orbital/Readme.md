# Orbital

Orbital is a purpose-built, decoupled development environment for Nervos CKB smart contracts.
It replaces fragmented tooling, manual node management, and error-prone deployment scripts with a unified, observable, and secure workflow. By separating the local execution runtime from the hosted orchestration layer, Orbital allows you to focus on contract logic rather than infrastructure coordination.

---

## Vision

Orbital exists to reduce cognitive and operational overhead in CKB development.
It is not a wallet, not a generic IDE plugin, and not a cloud deployment service. It is a local-first, privacy-respecting bridge that connects your local workspace to a centralized orchestration platform. It coordinates devnet lifecycle, contract compilation, on-chain deployment, and real-time feedback—within a strict, auditable security boundary.

Wallet management, session handling, and UI components are included strictly as secure enablers for isolated testing and deployment verification—not as end-user features.

---

## Core Principles

| Principle | What It Means |
|-----------|---------------|
| Local-First Execution | All heavy lifting—compilation, devnet management, and transaction preparation—occurs locally via the Orbkit CLI. No source code or private keys leave your machine. |
| Zero-Trust Security | Deployment utilizes a split-signing model. The local runtime prepares unsigned transactions, the frontend signs them via passkeys, and the backend merely broadcasts them. |
| Observability by Design | Every build, deploy, and funding step emits structured NDJSON events, enabling live debugging and state-aware development without log diving. |
| Reproducibility | Workspace scaffolding, devnet state, and contract artifacts are versioned and deterministic, ensuring consistent iteration across sessions and team members. |
| Developer Agency | The local runtime remains fully transparent and controllable. You retain ownership of your environment, RPC targets, and cryptographic material. |

---

## Capabilities

### Frictionless Workspace Initialization
A single CLI command (`orbital init`) scaffolds a complete CKB development workspace. It generates the Rust contract structure, configures the local runtime environment, and sets up the necessary RISC-V toolchain validations out of the box.

### Split-Signing Deployment Flow
Deployment is handled through a secure, three-step pipeline. Orbkit resolves cell dependencies and prepares the unsigned transaction. The frontend prompts the user to sign the exact payload via WebAuthn/Passkey. The backend then broadcasts the signed transaction to the target network. Private keys never traverse the network.

### Real-Time NDJSON Streaming
Instead of opaque polling, Orbital uses Newline Delimited JSON (NDJSON) to stream structured logs for compilation, funding, and deployment phases. This provides immediate, granular feedback directly in the dashboard, mapping backend states to visual progress indicators.

### Live Project Structure Synchronization
Orbkit monitors your local contract directory and streams structural analysis to the platform. It provides real-time visibility into file metrics, entrypoints, shared functions, and dependency graphs, with debounced differential updates to prevent performance degradation during rapid file changes.

### Integrated Test Funding
The platform bridges the local devnet and the UI, enabling one-click wallet funding. Orbkit handles the underlying UTXO selection and transfer execution, streaming balance synchronization and confirmation states back to the frontend in real time.

---

## Development Workflow

1. **Initialize** → Run `orbital init` to scaffold the project, configure the network, and prepare the local environment.
2. **Connect** → Start the Orbkit runtime. It registers with the hosted platform and establishes a secure command bridge.
3. **Execute** → Trigger build, deploy, or fund actions from the Orbital dashboard. The platform routes commands to your local Orbkit instance.
4. **Observe** → Monitor live NDJSON streams for compilation logs, deployment preparation, and funding confirmations.
5. **Sign & Broadcast** → For deployments, review the prepared transaction in the UI, sign it with your passkey, and let the platform broadcast it.
6. **Iterate** → Adjust contract logic. Orbkit's live sync and caching mechanisms ensure rapid rebuilds and immediate structural feedback.

This cycle is deterministic, secure, and fully integrated.

---

## Architectural Model

Orbital is structured as three distinct layers, enforcing strict separation of concerns and trust boundaries:

| Layer | Responsibility | Trust Boundary |
|-------|----------------|----------------|
| **Orbital Frontend** | React-based dashboard for state visualization, NDJSON consumption, and passkey-based transaction signing. | Browser-based, zero trust. Never handles private keys or raw compilation. |
| **Orbital Platform** | Hosted Node.js/Supabase backend. Manages sessions, routes commands via NDJSON, persists deployment metadata, and broadcasts signed transactions. | Authenticated, stateless routing. Does not execute local commands or hold signing keys. |
| **Orbkit Runtime** | Standalone local CLI. Manages the CKB devnet, compiles RISC-V contracts, prepares unsigned transactions, and watches local file structures. | Local machine, isolated. Holds the only access to local node RPC and workspace files. |

This decoupled architecture ensures that the platform can scale and provide cloud-based orchestration without ever compromising the security or privacy of the developer's local environment.

---

## Current Maturity

- **Core Architecture**: The decoupled Orbkit/Platform model is fully implemented, stable, and production-ready.
- **Execution Flows**: Build, deploy, and funding pipelines are complete, with robust NDJSON streaming and error handling.
- **Security Model**: Passkey split-signing, device-bound session tokens, and local-only key management are enforced.
- **Observability**: Live project structure sync and real-time command logging are fully operational and optimized for performance.
- **End-to-End Validation**: The complete workflow—from workspace initialization to passkey-signed deployment on devnet—has been verified and stabilized.

---

## Technology Philosophy

| Domain | Approach |
|--------|----------|
| **Chain Interaction** | CKB devnet/testnet/mainnet via OffCKB tooling, with explicit RPC and indexer configuration. |
| **Local Runtime** | Orbkit CLI built on Node.js, integrating the Rust toolchain and RISC-V target compilation. |
| **Backend & Routing** | Node.js with Supabase for persistence, GraphQL for state queries, and NDJSON over REST for high-frequency command streaming. |
| **Frontend** | React and TypeScript, focused on deployment observability, state machines for stream consumption, and WebAuthn integration. |
| **Identity & Signing** | Passkey/WebAuthn for session authentication and transaction signing. BIP39-derived accounts for test environments. |

---

Orbital is built for CKB developers who value control, clarity, and velocity.
It abstracts infrastructure complexity without sacrificing local sovereignty or security.
If you are iterating on contracts and require a repeatable, observable, and secure workflow: this is your environment.

No cloud lock-in. No exposed keys. Just contracts, deployed.