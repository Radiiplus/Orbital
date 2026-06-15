# Orbital Orbkit

**Orbkit** is the local runtime that connects your CKB smart contract workspace to the Orbital platform. It acts as the bridge between the Orbital web frontend and your local machine, handling devnet management, contract building, deployment, wallet funding, and project structure synchronization.

Instead of running complex CLI commands manually, you start Orbkit once, and the Orbital Frontend will send commands to it in real-time.

## Prerequisites

Before installing Orbkit, ensure you have the following installed on your system:

- **Node.js** (v18 or higher)
- **Rust Toolchain** (`cargo`, `rustc`)
- **RISC-V Target** for CKB contracts:
  ```bash
  rustup target add riscv64imac-unknown-none-elf
  ```
- **CKB CLI** (Automatically handled via `@offckb/cli` dependencies, but having it globally available helps).

## Installation & Initialization

You can install Orbkit globally or use it via `npx`.

**Global Install:**
```bash
npm install -g orbkit
```

**Initialize a new project:**
```bash
orbital init my-project
cd my-project
npm install
```
*(Or without global install: `npx orbkit init my-project`)*

This generates a complete workspace containing your Rust contract source code, an `orbkit/` runtime directory, and a pre-configured `.env` file.

## Configuration

Orbkit connects to the hosted Orbital Supabase backend by default — no configuration needed for the URL. You only need to set your API key.

### Quickstart (Hosted Backend — Recommended)
Set your API key and you're ready to go:
```env
ORBKIT_API_KEY=<your-helper-api-key-or-internal-orbkit-key>
```

*Note: The `ORBKIT_API_KEY` authenticates your local runtime with the backend. You can generate this key in the Orbital Frontend settings or find it in your backend's environment variables.*

## Starting the Runtime

Once configured, start the Orbkit runtime:

```bash
npm run orbkit
```

When started, Orbkit will:
1. Generate a unique service ID (e.g., `orbkit-4aa2cbce`).
2. Connect to your configured backend (via HTTP polling for Supabase, or WebSockets for local).
3. Register your workspace capabilities (build, deploy, fund, balance, sync).
4. Listen for incoming commands from the Orbital Frontend.

## How It Works (The Workflow)

You do not need to run build or deploy commands in your terminal. Orbkit listens to the Orbital Frontend.

1. **Project Structure Sync:** When you open your project in the Orbital UI, the frontend asks the backend for your file tree. Orbkit reads your local `contract/` directory and sends the structure to the UI.
2. **Funding:** If you need testnet/devnet CKB, click "Fund" in the UI. The backend tells Orbkit, which uses the local devnet funder to send CKB to your wallet.
3. **Building:** Click "Build" in the UI. Orbkit compiles your Rust contracts to the `riscv64imac-unknown-none-elf` target and streams the build logs back to the frontend.
4. **Deploying:** Click "Deploy" in the UI. Orbkit prepares the deployment transaction, the backend signs it with your wallet key, and broadcasts it to the selected network (Devnet, Testnet, or Mainnet).

## Troubleshooting

### Missing Rust Target
If builds fail with a target not found error, ensure you have added the RISC-V target:
```bash
rustup target add riscv64imac-unknown-none-elf
```

### WSL / Windows Path Issues
If you are running Orbkit inside Windows Subsystem for Linux (WSL), ensure your Rust toolchain is installed *inside* WSL, not on the Windows host. Orbkit includes path-translation helpers, but native WSL toolchains prevent compilation errors.

### Connection / API Key Errors
If Orbkit starts but the Frontend says "Disconnected" or "Offline":
- Verify your `ORBKIT_API_KEY` exactly matches the key configured in your Frontend/Backend.
- Check your terminal logs for HTTP 401 (Unauthorized) or 404 (Not Found) errors during the registration step.
- Restart the orbkit instance and refresh your dashboard

### Devnet Not Starting
If `devnet:setup` or funding fails, Orbkit relies on `@offckb/cli`. Ensure you have no conflicting local CKB nodes running on the default ports (usually 8114 for RPC and 8116 for Indexer).

---
