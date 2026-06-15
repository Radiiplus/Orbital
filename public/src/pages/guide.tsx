import {
  Activity,
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCopy,
  Code2,
  FileCode2,
  GitBranch,
  Globe2,
  Hammer,
  KeyRound,
  Link,
  LockKeyhole,
  Network,
  Radio,
  RefreshCw,
  Rocket,
  Rotate3D,
  ShieldCheck,
  TerminalSquare,
  WalletCards,
  Wifi,
  type LucideIcon,
} from 'lucide-react'
import { AUTH_PAGE_PATH, DASH_PAGE_PATH } from '../lib/session'

type FeatureItem = {
  title: string
  body: string
  icon: LucideIcon
  tone: string
}

type WorkflowItem = {
  step: string
  title: string
  body: string
}

const frontendFeatures: FeatureItem[] = [
  {
    title: 'Account onboarding',
    body: 'Create a username, generate a CKB wallet, review the mnemonic and addresses, then secure the account with passkey sign-in.',
    icon: LockKeyhole,
    tone: 'guide-tone-cyan',
  },
  {
    title: 'Existing account access',
    body: 'Look up an account by username, sign in with a saved passkey, or recover access with the wallet mnemonic and set up passkey sign-in again.',
    icon: ShieldCheck,
    tone: 'guide-tone-emerald',
  },
  {
    title: 'Secure access',
    body: 'Protected console pages require a signed-in account. If access expires or is unavailable, Orbital sends the user back to the authentication screen.',
    icon: RefreshCw,
    tone: 'guide-tone-slate',
  },
  {
    title: 'Network selector',
    body: 'Switch between devnet, testnet, and mainnet. The selected network controls wallet lists, balance reads, topup behavior, deployment estimates, and deploy requests.',
    icon: Globe2,
    tone: 'guide-tone-violet',
  },
  {
    title: 'Network health',
    body: 'Devnet is checked through the backend and connected Orbkit service. Testnet and mainnet are checked from the frontend through public CKB RPC endpoints.',
    icon: Wifi,
    tone: 'guide-tone-emerald',
  },
  {
    title: 'Orbkit runtime status',
    body: 'The console polls runtime status, shows whether Orbkit is online, displays the connected service id, and can request a runtime reconnect.',
    icon: Radio,
    tone: 'guide-tone-amber',
  },
  {
    title: 'Helper API key',
    body: 'The API key control loads, creates, rotates, reveals, hides, and copies the helper key used by a local Orbkit runtime to connect securely with Orbital.',
    icon: KeyRound,
    tone: 'guide-tone-rose',
  },
  {
    title: 'Wallet manager',
    body: 'Create wallets, link existing wallets by mnemonic, rename labels, select the active wallet, refresh balances, view details, export mnemonics with passkey authorization, and delete wallets.',
    icon: WalletCards,
    tone: 'guide-tone-cyan',
  },
  {
    title: 'Topup wizard',
    body: 'On devnet, stream a funded transfer into a selected wallet and refresh balances after completion. On testnet or mainnet, copy the wallet address and open the testnet faucet when available.',
    icon: CircleDollarSign,
    tone: 'guide-tone-emerald',
  },
  {
    title: 'Build lane',
    body: 'Read contract configuration from Orbkit, select a contract, request a build, and stream queued, accepted, building, completed, or failed events into the UI.',
    icon: Hammer,
    tone: 'guide-tone-amber',
  },
  {
    title: 'Deploy lane',
    body: 'Estimate deploy size and fee, request passkey authorization, prepare and sign the deployment, broadcast to the selected network, and update the last deployment summary.',
    icon: Rocket,
    tone: 'guide-tone-violet',
  },
  {
    title: 'Workspace readiness',
    body: 'Summarize the last deployment with contract path, network, transaction hash, wallet, deploy address, binary size, deploy kind, code hash, Type ID, and updated time.',
    icon: ClipboardCopy,
    tone: 'guide-tone-slate',
  },
  {
    title: 'Project structure',
    body: 'Sync the local contract tree from Orbkit, display file and directory counts, code lines, function totals, dependencies, package metadata, and structure stream events.',
    icon: Boxes,
    tone: 'guide-tone-cyan',
  },
  {
    title: 'Structure search and details',
    body: 'Search files by name, path, or behavior classification. Open details to inspect functions, detected features, VM calls, imports, and source analysis.',
    icon: FileCode2,
    tone: 'guide-tone-emerald',
  },
  {
    title: 'Dependency graphs',
    body: 'Open a full workspace graph or a file-focused graph to explore files, functions, imports, imported-by relationships, and external dependencies in an interactive canvas.',
    icon: Network,
    tone: 'guide-tone-amber',
  },
  {
    title: 'Realtime streams',
    body: 'Funding, build, deploy, and structure operations use streamed events so the console can show progress while Orbkit and the backend are still working.',
    icon: Activity,
    tone: 'guide-tone-rose',
  },
]

const workflows: WorkflowItem[] = [
  {
    step: '01',
    title: 'Enter Orbital',
    body: 'Create a new account or sign in to an existing account. Once authenticated, the dashboard can safely load wallets, contracts, and project operations.',
  },
  {
    step: '02',
    title: 'Prepare a wallet',
    body: 'Create, link, or select a wallet for the current network. Devnet wallets can be funded from the Topup wizard when Orbkit is reachable.',
  },
  {
    step: '03',
    title: 'Connect Orbkit',
    body: 'Start Orbkit in your contract workspace from the terminal you use for development. The dashboard detects the service and reads configured contracts.',
  },
  {
    step: '04',
    title: 'Inspect the project',
    body: 'Sync structure to confirm the contract source, dependencies, entrypoints, functions, and behavior analysis before building or deploying.',
  },
  {
    step: '05',
    title: 'Build and deploy',
    body: 'Build the selected contract, review deploy readiness, authorize with a passkey, then deploy and track the streamed result through the receipt summary.',
  },
]

const orbkitSteps: WorkflowItem[] = [
  {
    step: '01',
    title: 'Install or run from npm',
    body: 'Install globally with npm install -g orbkit, or use npx orbkit init <project-name> without a global install. The npm flow works from Windows, macOS, Linux, and WSL terminals.',
  },
  {
    step: '02',
    title: 'Create a workspace',
    body: 'Run orbital init my-project. The CLI creates a Rust contract template, an orbkit runtime folder, orbital.config.js, package scripts, deployment output, and a cross-platform .env file.',
  },
  {
    step: '03',
    title: 'Set the helper key',
    body: 'Copy or create the key from the frontend API Key control and set ORBKIT_API_KEY in the generated .env file. Using .env avoids shell-specific export, set, or PowerShell syntax.',
  },
  {
    step: '04',
    title: 'Start the runtime',
    body: 'Run npm run orbkit from the generated workspace. npm scripts keep the command the same across supported platforms while Orbkit registers build, deploy, fund, balance, and structure capabilities.',
  },
  {
    step: '05',
    title: 'Operate from the dashboard',
    body: 'Use the frontend for funding, structure sync, builds, deploy simulation, deployment, and receipt review. Orbkit performs the local work and streams events back.',
  },
]

const commands = [
  ['npm install -g orbkit', 'Install the public package globally from any Node.js-supported terminal.'],
  ['npx orbkit init my-project', 'Create a new workspace without a global install on Windows, macOS, Linux, or WSL.'],
  ['orbital init my-project', 'Use the installed CLI binary to generate a workspace.'],
  ['orbital init my-project --dir ./sandbox', 'Create the workspace inside a target directory using a relative path.'],
  ['npm install', 'Install generated workspace dependencies with the same command on every platform.'],
  ['npm run orbkit', 'Start the local runtime and connect it to Orbital.'],
  ['npm run devnet:setup', 'Prepare local devnet support when needed; on Windows, run this from WSL when your CKB toolchain lives there.'],
  ['npm run wallet:create', 'Create a local CKB wallet from the runtime scripts.'],
  ['npm run fund:devnet -- <walletAddress> <amountInCKB>', 'Fund a devnet wallet from the local tooling.'],
  ['npm run balance -- <walletAddress> --network devnet', 'Read a wallet balance for the selected network.'],
  ['npm run build:deploy -- --network devnet --build', 'Build and deploy from the command line path.'],
  ['npm run deploy:sim', 'Simulate deployment details before broadcasting.'],
  ['npm run structure', 'Read or sync contract structure from the runtime tooling.'],
]

const configRows = [
  ['ORBKIT_API_KEY', 'Required helper key for securely connecting the local runtime with Orbital.'],
  ['ORBITAL_SUPABASE_FUNCTION_URL', 'Hosted Supabase Edge Function endpoint. The generated workspace includes the default value.'],
  ['ORBKIT_BACKEND_MODE', 'Transport mode used by the runtime. The generated template uses firebase for the hosted flow.'],
  ['ORBITAL_SERVER_GRAPHQL_URL', 'Optional local GraphQL backend override for custom or local deployments.'],
]

const platformRows = [
  ['Windows', 'Use PowerShell, Command Prompt, or WSL for npm commands. For Rust contract builds and local devnet workflows, WSL is recommended when the Linux CKB toolchain is required.'],
  ['macOS', 'Use Terminal or another shell with Node.js, Rust, and the RISC-V target installed. The generated npm scripts and .env workflow stay the same.'],
  ['Linux', 'Use your normal shell with Node.js and Rust installed. Orbkit can run beside your local CKB tooling and contract workspace.'],
  ['WSL', 'Works well for Windows development when the Rust compiler, CKB tools, and project files live inside the Linux environment. Start Orbkit from the same environment that builds the contract.'],
]

function FeatureCard({ item }: { item: FeatureItem }) {
  const Icon = item.icon
  return (
    <article className="guide-card">
      <span className={`guide-icon ${item.tone}`}>
        <Icon size={19} strokeWidth={2.25} />
      </span>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
    </article>
  )
}

function WorkflowCard({ item }: { item: WorkflowItem }) {
  return (
    <article className="guide-step-card">
      <span>{item.step}</span>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
    </article>
  )
}

function SectionHeader({
  kicker,
  title,
  body,
}: {
  kicker: string
  title: string
  body: string
}) {
  return (
    <div className="guide-section-header">
      <p className="auth-kicker">{kicker}</p>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  )
}

export default function GuidePage() {
  return (
    <main className="guide-page min-h-screen w-full max-w-[100dvw] overflow-x-hidden bg-[#000000] text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_78%_8%,rgba(34,211,238,0.14),transparent_28%),radial-gradient(circle_at_8%_66%,rgba(16,185,129,0.1),transparent_24%)]" />
      <div className="relative mx-auto grid w-full max-w-7xl gap-5 px-3 py-3 sm:px-5 sm:py-5 lg:px-7 lg:py-7">
        <header className="guide-topbar app-reveal">
          <a className="guide-brand" href={DASH_PAGE_PATH} title="Orbital dashboard">
            <span>
              <Rotate3D size={23} strokeWidth={2.4} />
            </span>
            <span>
              <strong>Orbital Guide</strong>
              <small>Frontend and Orbkit reference</small>
            </span>
          </a>
          <nav aria-label="Guide actions" className="guide-actions">
            <a href="#frontend">Frontend</a>
            <a href="#orbkit">Orbkit</a>
            <a href={AUTH_PAGE_PATH}>Authenticate</a>
            <a className="guide-primary-link" href={DASH_PAGE_PATH}>
              Dashboard
              <ArrowRight size={15} />
            </a>
          </nav>
        </header>

        <section className="guide-hero app-reveal">
          <div className="guide-hero-copy">
            <p className="auth-kicker">Product Manual</p>
            <h1>Everything Orbital exposes in the frontend, and how Orbkit powers it locally.</h1>
            <p>
              This page is a practical operating guide for the dashboard: what each control does, how the pieces move data,
              and how the public npm package connects a CKB smart contract workspace to Orbital.
            </p>
            <div className="guide-hero-actions">
              <a className="auth-primary-button guide-hero-button" href="#frontend">
                Explore features
              </a>
              <a className="auth-ghost-button guide-hero-button" href="https://www.npmjs.com/package/orbkit" rel="noreferrer" target="_blank">
                npm orbkit
              </a>
            </div>
          </div>

          <aside className="guide-snapshot" aria-label="Orbkit package snapshot">
            <p className="auth-kicker">Package Snapshot</p>
            <div className="guide-snapshot-grid">
              <div>
                <span>npm package</span>
                <strong>orbkit</strong>
              </div>
              <div>
                <span>latest verified</span>
                <strong>0.1.1</strong>
              </div>
              <div>
                <span>CLI binary</span>
                <strong>orbital</strong>
              </div>
              <div>
                <span>runtime script</span>
                <strong>npm run orbkit</strong>
              </div>
            </div>
          </aside>
        </section>

        <section className="guide-band app-reveal" id="frontend">
          <SectionHeader
            kicker="Frontend"
            title="Feature Map"
            body="The console is organized around account security, wallet custody, local runtime connectivity, contract operations, and project intelligence."
          />
          <div className="guide-feature-grid">
            {frontendFeatures.map((item) => (
              <FeatureCard item={item} key={item.title} />
            ))}
          </div>
        </section>

        <section className="guide-split app-reveal">
          <div>
            <SectionHeader
              kicker="Dashboard Flow"
              title="How a normal workflow moves"
              body="A typical contract workflow starts with sign-in, proves wallet control when needed, connects Orbkit, then streams local project work into the hosted console."
            />
            <div className="guide-steps">
              {workflows.map((item) => (
                <WorkflowCard item={item} key={item.step} />
              ))}
            </div>
          </div>

          <aside className="guide-callout">
            <span className="guide-icon guide-tone-emerald">
              <CheckCircle2 size={20} strokeWidth={2.3} />
            </span>
            <h3>What the frontend never does alone</h3>
            <p>
              The browser does not compile Rust contracts or inspect your local filesystem directly. It sends authorized requests
              to Orbital, and Orbital coordinates work with the connected Orbkit runtime that is running in your workspace.
            </p>
          </aside>
        </section>

        <section className="guide-band app-reveal" id="orbkit">
          <SectionHeader
            kicker="Orbkit"
            title="Local Runtime Usage"
            body="Orbkit is the cross-platform bridge between the hosted Orbital UI and your local CKB smart contract project. Start it from the same environment that owns your project toolchain, then use the dashboard for day-to-day work."
          />

          <div className="guide-orbkit-layout">
            <div className="guide-steps">
              {orbkitSteps.map((item) => (
                <WorkflowCard item={item} key={item.step} />
              ))}
            </div>

            <aside className="guide-terminal">
              <div className="guide-terminal-title">
                <TerminalSquare size={18} />
                <span>Quickstart</span>
              </div>
              <pre>{`npm install -g orbkit
orbital init my-project
cd my-project
npm install

# add ORBKIT_API_KEY to .env
npm run orbkit`}</pre>
            </aside>
          </div>
        </section>

        <section className="guide-band app-reveal">
          <SectionHeader
            kicker="Cross Platform"
            title="Use the same product flow on every development machine"
            body="Orbital keeps daily actions in the browser and Orbkit keeps local project work in your terminal. The command style is npm-first, so the same workspace scripts can be used across operating systems."
          />
          <div className="guide-capability-grid">
            {platformRows.map(([platform, body]) => (
              <article className="guide-capability" key={platform}>
                <Globe2 size={18} />
                <strong>{platform}</strong>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="guide-split app-reveal">
          <div className="guide-panel">
            <div className="guide-inline-title">
              <Code2 size={18} />
              <h2>Commands</h2>
            </div>
            <div className="guide-command-list">
              {commands.map(([command, body]) => (
                <article key={command}>
                  <code>{command}</code>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="guide-panel">
            <div className="guide-inline-title">
              <GitBranch size={18} />
              <h2>Configuration</h2>
            </div>
            <div className="guide-config-list">
              {configRows.map(([name, body]) => (
                <article key={name}>
                  <strong>{name}</strong>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="guide-band app-reveal">
          <SectionHeader
            kicker="Runtime Link"
            title="What Orbkit reports back"
            body="When connected, Orbkit reports the workspace, config path, configured contracts, and supported capabilities. The frontend uses those details to select contracts, reconnect services, sync structure, and stream build/deploy events."
          />
          <div className="guide-capability-grid">
            {[
              [Link, 'Service registration', 'Identifies the local runtime instance and keeps its status fresh.'],
              [Boxes, 'Structure sync', 'Reads contract folders, metrics, manifests, imports, and analysis.'],
              [CircleDollarSign, 'Funding', 'Handles devnet funding requests and streams request phases.'],
              [WalletCards, 'Balances', 'Reads balances so wallet tiles and deploy panels stay current.'],
              [Hammer, 'Builds', 'Runs contract builds and returns binary outputs and logs.'],
              [Rocket, 'Deployment', 'Prepares deployment data and broadcasts signed transactions.'],
            ].map(([Icon, title, body]) => {
              const CapabilityIcon = Icon as LucideIcon
              return (
                <article className="guide-capability" key={String(title)}>
                  <CapabilityIcon size={18} />
                  <strong>{title as string}</strong>
                  <p>{body as string}</p>
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
