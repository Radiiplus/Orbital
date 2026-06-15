import {
  Activity,
  Boxes,
  Code2,
  Home,
  Rotate3D,
  Rocket,
  Settings,
  WalletCards,
} from 'lucide-react'

const navItems = [
  { label: 'Home', icon: Home, active: true },
  { label: 'Wallets', icon: WalletCards },
  { label: 'Contracts', icon: Code2 },
  { label: 'Structure', icon: Boxes },
  { label: 'Deploy', icon: Rocket },
  { label: 'Telemetry', icon: Activity },
  { label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  return (
    <aside className="glass-panel fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-[1.6rem] p-2 md:sticky md:top-6 md:left-auto md:h-[calc(100vh-3rem)] md:w-[5.5rem] md:translate-x-0 md:flex-col md:rounded-[2rem] md:p-3">
      <a
        aria-label="Orbital home"
        className="app-icon-button hidden bg-zinc-100 text-black md:flex"
        href="/dash"
        title="Orbital"
      >
        <Rotate3D size={22} strokeWidth={2.4} />
      </a>

      <nav aria-label="Primary" className="flex items-center gap-2 md:mt-4 md:flex-1 md:flex-col">
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <a
              aria-current={item.active ? 'page' : undefined}
              aria-label={item.label}
              className={`app-icon-button ${item.active ? 'app-icon-button-active' : ''}`}
              href={item.active ? '/dash' : `#${item.label.toLowerCase()}`}
              key={item.label}
              title={item.label}
            >
              <Icon size={20} strokeWidth={2.15} />
              <span className="sr-only">{item.label}</span>
            </a>
          )
        })}
      </nav>
    </aside>
  )
}
