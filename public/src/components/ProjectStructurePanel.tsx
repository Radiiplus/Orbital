import {
  Activity,
  Check,
  ChevronDown,
  Copy,
  File,
  FolderTree,
  GitBranch,
  Loader2,
  Network,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  configureProjectStructureLive,
  fetchContractConfig,
  fetchLatestProjectStructure,
  normalizeStructureSnapshot,
  readProjectStructureStream,
  syncProjectStructure,
  type ContractConfigItem,
  type ContractStructureItem,
  type ContractStructureSnapshot,
  type ProjectStructureEvent,
} from '../lib/structure'

const FALLBACK_CONTRACT: ContractConfigItem = {
  id: '',
  name: 'No contract',
  path: '',
  script: '',
  build: null,
}

type GraphNode = {
  id: string
  label: string
  group: 'focus-file' | 'file' | 'function' | 'external'
}

type GraphEdge = {
  from: string
  to: string
}

function shortPath(value: string, max = 28) {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(8, max - 13))}/.../${value.slice(-10)}`
}

function flattenStructure(items: ContractStructureItem[]) {
  const output: ContractStructureItem[] = []
  function walk(nodes: ContractStructureItem[]) {
    for (const node of nodes) {
      output.push(node)
      if (node.children?.length) walk(node.children)
    }
  }
  walk(items)
  return output
}

function eventTime(value?: string) {
  if (!value) return '--:--:--'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function statusTone(status?: string) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'ready' || normalized === 'completed' || normalized === 'configured') {
    return 'border-emerald-300/25 bg-emerald-500/10 text-emerald-100'
  }
  if (normalized === 'failed' || normalized === 'error') {
    return 'border-rose-300/25 bg-rose-500/10 text-rose-100'
  }
  return 'border-cyan-300/20 bg-cyan-500/10 text-cyan-100'
}

function syncLatestEvent(event: ProjectStructureEvent & { latest?: ProjectStructureEvent | null }) {
  return event.latest || event
}

function buildFileGraph(item: ContractStructureItem, filePathSet: Set<string>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const metrics = item.metrics
  if (!metrics) return { nodes: [], edges: [] }

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const fileId = `file:${item.path}`
  nodes.set(fileId, { id: fileId, label: item.path, group: 'focus-file' })

  for (const name of metrics.functionNames || []) {
    const id = `fn:${item.path}:${name}`
    nodes.set(id, { id, label: name, group: 'function' })
    edges.push({ from: fileId, to: id })
  }

  for (const dep of metrics.imports || []) {
    const local = filePathSet.has(dep)
    const id = local ? `file:${dep}` : `ext:${dep}`
    nodes.set(id, { id, label: dep, group: local ? 'file' : 'external' })
    edges.push({ from: fileId, to: id })
  }

  for (const source of metrics.importedBy || []) {
    const id = `file:${source}`
    nodes.set(id, { id, label: source, group: 'file' })
    edges.push({ from: id, to: fileId })
  }

  return { nodes: Array.from(nodes.values()), edges }
}

function buildFullGraph(fileItems: ContractStructureItem[], filePathSet: Set<string>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []

  for (const item of fileItems) {
    const fileId = `file:${item.path}`
    nodes.set(fileId, { id: fileId, label: item.path, group: 'file' })

    for (const name of item.metrics?.functionNames || []) {
      const id = `fn:${item.path}:${name}`
      nodes.set(id, { id, label: name, group: 'function' })
      edges.push({ from: fileId, to: id })
    }
  }

  for (const item of fileItems) {
    const fromId = `file:${item.path}`
    for (const dep of item.metrics?.imports || []) {
      const local = filePathSet.has(dep)
      const toId = local ? `file:${dep}` : `ext:${dep}`
      if (!nodes.has(toId)) {
        nodes.set(toId, { id: toId, label: dep, group: local ? 'file' : 'external' })
      }
      edges.push({ from: fromId, to: toId })
    }
  }

  return { nodes: Array.from(nodes.values()), edges }
}

function GraphModal({
  open,
  title,
  nodes,
  edges,
  onClose,
}: {
  open: boolean
  title: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [animating, setAnimating] = useState(true)
  const [hoveredLabel, setHoveredLabel] = useState('')
  const cameraRef = useRef(980)
  const panRef = useRef({ x: 0, y: 0 })
  const redrawRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!open) return
    cameraRef.current = 980
    panRef.current = { x: 0, y: 0 }

    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const resize = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    window.addEventListener('resize', resize)

    const radius = 150
    const points = nodes.map((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2
      const bend = ((index * 1.618) % 1) * Math.PI
      return {
        ...node,
        x: Math.cos(angle) * Math.sin(bend) * radius,
        y: Math.sin(angle) * Math.sin(bend) * radius,
        z: Math.cos(bend) * radius,
      }
    })

    let rotationX = 0.18
    let rotationY = 0.28
    let dragging = false
    let panning = false
    let lastX = 0
    let lastY = 0
    let frame = 0
    const activePointers = new Map<number, { x: number; y: number }>()
    let pinchStartDistance = 0
    let pinchStartCamera = cameraRef.current
    let lastProjected: Array<{ label: string; sx: number; sy: number }> = []

    const nodeColor = (group: GraphNode['group']) => {
      if (group === 'focus-file') return 'rgba(103,232,249,0.96)'
      if (group === 'file') return 'rgba(110,231,183,0.92)'
      if (group === 'function') return 'rgba(251,191,36,0.93)'
      return 'rgba(226,232,240,0.86)'
    }

    const draw = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const cameraDistance = cameraRef.current
      const pan = panRef.current
      const zOffset = 380

      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#050505'
      ctx.fillRect(0, 0, width, height)

      const gradient = ctx.createRadialGradient(width * 0.5, height * 0.25, 20, width * 0.5, height * 0.45, Math.max(width, height) * 0.7)
      gradient.addColorStop(0, 'rgba(34,211,238,0.13)')
      gradient.addColorStop(0.42, 'rgba(16,185,129,0.06)')
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)

      const cosY = Math.cos(rotationY)
      const sinY = Math.sin(rotationY)
      const cosX = Math.cos(rotationX)
      const sinX = Math.sin(rotationX)
      const projected = points.map((point) => {
        const x1 = point.x * cosY - point.z * sinY
        const z1 = point.x * sinY + point.z * cosY
        const y2 = point.y * cosX - z1 * sinX
        const z2 = point.y * sinX + z1 * cosX
        const depth = cameraDistance + z2 + zOffset
        const scale = cameraDistance / Math.max(120, depth)
        return {
          ...point,
          sx: width / 2 + pan.x + x1 * scale,
          sy: height / 2 + pan.y + y2 * scale,
          scale: Math.max(0.65, Math.min(1.28, scale)),
        }
      })

      const map = new Map(projected.map((point) => [point.id, point]))
      ctx.lineWidth = 1
      for (const edge of edges) {
        const from = map.get(edge.from)
        const to = map.get(edge.to)
        if (!from || !to) continue
        ctx.strokeStyle = 'rgba(148,163,184,0.24)'
        ctx.beginPath()
        ctx.moveTo(from.sx, from.sy)
        ctx.lineTo(to.sx, to.sy)
        ctx.stroke()
      }

      for (const point of projected.sort((a, b) => a.scale - b.scale)) {
        ctx.fillStyle = nodeColor(point.group)
        ctx.shadowBlur = point.group === 'focus-file' ? 20 : 10
        ctx.shadowColor = nodeColor(point.group)
        ctx.beginPath()
        ctx.arc(point.sx, point.sy, 2.5 + point.scale * 3.2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.shadowBlur = 0

      ctx.font = '11px IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textBaseline = 'middle'
      for (const point of projected) {
        const tag = point.group === 'focus-file' ? 'FOCUS' : point.group === 'file' ? 'FILE' : point.group === 'function' ? 'FN' : 'EXT'
        const text = `${tag}: ${point.label.length > 32 ? `${point.label.slice(0, 29)}...` : point.label}`
        const textWidth = ctx.measureText(text).width
        const x = point.sx - textWidth / 2
        const y = point.sy - 15

        ctx.fillStyle = 'rgba(0,0,0,0.74)'
        ctx.fillRect(x - 4, y - 8, textWidth + 8, 16)
        ctx.fillStyle = nodeColor(point.group)
        ctx.fillText(text, x, y)
      }

      lastProjected = projected.map((point) => ({ label: point.label, sx: point.sx, sy: point.sy }))
    }

    redrawRef.current = draw

    const tick = () => {
      if (animating && !dragging) {
        rotationY += 0.003
        rotationX += 0.001
      }
      draw()
      frame = window.requestAnimationFrame(tick)
    }

    const onPointerDown = (event: PointerEvent) => {
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (activePointers.size === 2) {
        const [a, b] = Array.from(activePointers.values())
        pinchStartDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1
        pinchStartCamera = cameraRef.current
      }
      dragging = true
      panning = event.shiftKey
      lastX = event.clientX
      lastY = event.clientY
      canvas.setPointerCapture?.(event.pointerId)
    }

    const onPointerMoveWindow = (event: PointerEvent) => {
      if (!dragging) return
      if (activePointers.has(event.pointerId)) {
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      }

      if (activePointers.size >= 2) {
        const [a, b] = Array.from(activePointers.values()).slice(0, 2)
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1
        cameraRef.current = Math.max(620, pinchStartCamera * (pinchStartDistance / distance))
        const centerX = (a.x + b.x) / 2
        const centerY = (a.y + b.y) / 2
        panRef.current = {
          x: panRef.current.x + centerX - lastX,
          y: panRef.current.y + centerY - lastY,
        }
        lastX = centerX
        lastY = centerY
        return
      }

      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      if (panning) {
        panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy }
        return
      }
      rotationY += dx * 0.005
      rotationX = Math.max(-1.2, Math.min(1.2, rotationX + dy * 0.005))
    }

    const onPointerUp = (event: PointerEvent) => {
      activePointers.delete(event.pointerId)
      if (activePointers.size === 0) dragging = false
    }

    const onPointerHover = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      let nearest: { label: string; distance: number } | null = null
      for (const point of lastProjected) {
        const distance = (point.sx - x) ** 2 + (point.sy - y) ** 2
        if (distance > 225) continue
        if (!nearest || distance < nearest.distance) nearest = { label: point.label, distance }
      }
      setHoveredLabel(nearest?.label || '')
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      cameraRef.current = Math.max(620, cameraRef.current * (event.deltaY > 0 ? 1.12 : 0.88))
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerHover)
    window.addEventListener('pointermove', onPointerMoveWindow)
    window.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    frame = window.requestAnimationFrame(tick)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerHover)
      window.removeEventListener('pointermove', onPointerMoveWindow)
      window.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      redrawRef.current = null
    }
  }, [open, nodes, edges, animating])

  if (!open) return null

  const zoomIn = () => {
    cameraRef.current = Math.max(620, cameraRef.current * 0.86)
    redrawRef.current?.()
  }
  const zoomOut = () => {
    cameraRef.current *= 1.2
    redrawRef.current?.()
  }
  const resetView = () => {
    cameraRef.current = 980
    panRef.current = { x: 0, y: 0 }
    redrawRef.current?.()
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/82 p-3 backdrop-blur-md sm:p-5">
      <section className="glass-panel flex max-h-[92vh] w-[min(100%,64rem)] flex-col overflow-hidden p-3 sm:p-4">
        <div className="flex flex-col gap-3 border-b border-white/10 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="auth-kicker">Structure Graph</p>
            <h3 className="mt-1 truncate text-lg font-bold text-white sm:text-xl">{title}</h3>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center sm:justify-end">
            <button className="rounded-lg bg-white/[0.055] px-2 py-2 text-[11px] font-bold text-zinc-200 transition hover:bg-white/[0.09]" onClick={zoomIn} type="button">Zoom In</button>
            <button className="rounded-lg bg-white/[0.055] px-2 py-2 text-[11px] font-bold text-zinc-200 transition hover:bg-white/[0.09]" onClick={zoomOut} type="button">Zoom Out</button>
            <button className="rounded-lg bg-white/[0.055] px-2 py-2 text-[11px] font-bold text-zinc-200 transition hover:bg-white/[0.09]" onClick={resetView} type="button">Reset</button>
            <button className="rounded-lg bg-cyan-500/15 px-2 py-2 text-[11px] font-bold text-cyan-100 transition hover:bg-cyan-500/25" onClick={() => setAnimating((current) => !current)} type="button">
              {animating ? 'Pause' : 'Animate'}
            </button>
            <button className="rounded-lg bg-white/[0.055] px-2 py-2 text-[11px] font-bold text-zinc-200 transition hover:bg-white/[0.09] sm:col-auto" onClick={onClose} type="button">Close</button>
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_13rem]">
          <canvas ref={canvasRef} className="h-[54vh] min-h-[22rem] w-full touch-none rounded-[1.1rem] border border-white/10 bg-black sm:h-[64vh]" />
          <aside className="grid content-start gap-2 rounded-[1.1rem] border border-white/10 bg-white/[0.035] p-3 text-xs text-zinc-400">
            {[
              ['Focus', 'bg-cyan-300'],
              ['Files', 'bg-emerald-300'],
              ['Functions', 'bg-amber-300'],
              ['External', 'bg-zinc-200'],
            ].map(([label, color]) => (
              <div className="flex items-center gap-2" key={label}>
                <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
                <span>{label}</span>
              </div>
            ))}
            <div className="my-1 h-px bg-white/10" />
            <p>{nodes.length.toLocaleString()} nodes</p>
            <p>{edges.length.toLocaleString()} links</p>
            <p className="pt-2 leading-5 text-zinc-500">Drag to rotate. Shift-drag to pan. Wheel or pinch to zoom.</p>
            <p className="truncate pt-1 font-mono text-cyan-100" title={hoveredLabel}>{hoveredLabel || 'Hover a node'}</p>
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function DetailModal({
  item,
  onClose,
}: {
  item: ContractStructureItem | null
  onClose: () => void
}) {
  if (!item) return null
  const metrics = item.metrics
  const analysis = metrics?.analysis

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-3 backdrop-blur-md sm:p-5">
      <section className="glass-panel app-compact-scrollbar max-h-[90vh] w-[min(100%,46rem)] overflow-y-auto p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="auth-kicker">Structure Details</p>
            <h3 className="mt-2 truncate text-2xl font-bold text-white">{item.name}</h3>
            <p className="mt-2 truncate font-mono text-xs text-zinc-500" title={item.path}>{item.path}</p>
          </div>
          <button
            aria-label="Close structure details"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[1rem] border border-white/10 bg-white/[0.04] text-zinc-300 transition hover:border-white/25 hover:bg-white/[0.08]"
            onClick={onClose}
            type="button"
          >
            <X size={17} />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.035] p-3">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Lines</p>
            <p className="mt-2 text-2xl font-bold text-white">{metrics?.lines ?? 0}</p>
          </div>
          <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.035] p-3">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Functions</p>
            <p className="mt-2 text-2xl font-bold text-white">{metrics?.functions ?? 0}</p>
          </div>
          <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.035] p-3">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Behavior</p>
            <p className="mt-2 truncate text-sm font-bold text-cyan-100">{analysis?.behaviorClassification || 'not analyzed'}</p>
          </div>
        </div>

        {metrics?.functionNames?.length ? (
          <section className="mt-4 rounded-[1.15rem] border border-amber-300/15 bg-amber-500/[0.06] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-100">Functions</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {metrics.functionNames.map((name) => (
                <span className="rounded-lg bg-amber-500/15 px-2 py-1 font-mono text-xs text-amber-100" key={name}>{name}</span>
              ))}
            </div>
          </section>
        ) : null}

        {analysis?.features?.length ? (
          <section className="mt-4 rounded-[1.15rem] border border-cyan-300/15 bg-cyan-500/[0.06] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-100">Detected Features</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {analysis.features.map((feature) => (
                <span className="rounded-lg bg-cyan-500/15 px-2 py-1 text-xs text-cyan-100" key={feature}>{feature}</span>
              ))}
            </div>
          </section>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <section className="rounded-[1.15rem] border border-white/10 bg-white/[0.035] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Imports</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">
              {metrics?.imports?.length ? metrics.imports.join(', ') : 'No imports detected.'}
            </p>
          </section>
          <section className="rounded-[1.15rem] border border-white/10 bg-white/[0.035] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Imported By</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">
              {metrics?.importedBy?.length ? metrics.importedBy.join(', ') : 'No local references detected.'}
            </p>
          </section>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function StructureCard({
  item,
  onDetails,
  onCopy,
  onGraph,
  copied,
}: {
  item: ContractStructureItem
  onDetails: (item: ContractStructureItem) => void
  onCopy: (path: string) => void
  onGraph: (item: ContractStructureItem) => void
  copied: boolean
}) {
  const isDirectory = item.type === 'directory'
  const metrics = item.metrics
  const analysis = metrics?.analysis

  return (
    <article className="min-w-0 rounded-[1.1rem] border border-white/10 bg-black/30 p-3 shadow-[inset_7px_7px_16px_rgba(0,0,0,0.48),inset_-6px_-6px_14px_rgba(255,255,255,0.03)] sm:rounded-[1.35rem] sm:p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-[1rem] ${
          isDirectory ? 'bg-cyan-500/14 text-cyan-200' : 'bg-white/[0.055] text-zinc-300'
        }`}>
          {isDirectory ? <FolderTree size={19} /> : <File size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-white" title={item.name}>{item.name}</p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-500">{item.type}</p>
          <p className="mt-2 truncate font-mono text-xs text-zinc-500" title={item.path}>{shortPath(item.path)}</p>
        </div>
      </div>

      <div className="mt-4 min-h-[4.5rem]">
        {metrics ? (
          <>
            <p className="text-xs leading-5 text-zinc-300">
              {metrics.lines.toLocaleString()} lines · {metrics.functions.toLocaleString()} functions
            </p>
            {analysis?.behaviorClassification && (
              <p className="mt-1 truncate text-xs text-cyan-200">{analysis.behaviorClassification}</p>
            )}
            {metrics.functionNames?.length ? (
              <p className="mt-1 truncate font-mono text-[11px] text-amber-200">
                fn: {metrics.functionNames.join(', ')}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs leading-5 text-zinc-500">{item.children?.length ?? 0} child item(s)</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {metrics && (
          <button
            className="rounded-lg bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-bold text-cyan-100 transition hover:bg-cyan-500/25"
            onClick={() => onDetails(item)}
            type="button"
          >
            Details
          </button>
        )}
        <button
          className="inline-flex items-center gap-1 rounded-lg bg-white/[0.055] px-2.5 py-1.5 text-[11px] font-bold text-zinc-200 transition hover:bg-white/[0.085]"
          onClick={() => onCopy(item.path)}
          type="button"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Path'}
        </button>
        {metrics && (
          <button
            className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/12 px-2.5 py-1.5 text-[11px] font-bold text-emerald-100 transition hover:bg-emerald-500/22"
            onClick={() => onGraph(item)}
            type="button"
          >
            <Network size={13} />
            Graph
          </button>
        )}
      </div>
    </article>
  )
}

export default function ProjectStructurePanel({
  preferredContractPath,
  preferredService,
  runtimeRefreshKey = 0,
}: {
  preferredContractPath?: string | null
  preferredService?: string | null
  runtimeRefreshKey?: number
}) {
  const [contracts, setContracts] = useState<ContractConfigItem[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [configSource, setConfigSource] = useState('pending')
  const [runtimeService, setRuntimeService] = useState<string | null>(null)
  const [contractsSourcePath, setContractsSourcePath] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ContractStructureSnapshot | null>(null)
  const [events, setEvents] = useState<ProjectStructureEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [liveSync, setLiveSync] = useState(false)
  const [detailItem, setDetailItem] = useState<ContractStructureItem | null>(null)
  const [copiedPath, setCopiedPath] = useState('')
  const [query, setQuery] = useState('')
  const [graphOpen, setGraphOpen] = useState(false)
  const [graphTitle, setGraphTitle] = useState('Dependency + Function Graph')
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([])

  const selectedContract = contracts.find((contract) => contract.path === selectedPath) || contracts[0] || FALLBACK_CONTRACT
  const flattenedItems = useMemo(() => flattenStructure(snapshot?.items || []), [snapshot])
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return flattenedItems
    return flattenedItems.filter((item) => (
      item.name.toLowerCase().includes(normalized)
      || item.path.toLowerCase().includes(normalized)
      || item.metrics?.analysis?.behaviorClassification?.toLowerCase().includes(normalized)
    ))
  }, [flattenedItems, query])
  const previewItems = filteredItems.slice(0, 12)
  const fileCount = flattenedItems.filter((item) => item.type === 'file').length
  const directoryCount = flattenedItems.filter((item) => item.type === 'directory').length
  const fileItems = useMemo(() => flattenedItems.filter((item) => item.type === 'file'), [flattenedItems])
  const filePathSet = useMemo(() => new Set(fileItems.map((item) => item.path)), [fileItems])
  const latestEvent = events[0]
  const snapshotRef = useRef<ContractStructureSnapshot | null>(null)

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    let mounted = true
    fetchContractConfig()
      .then((result) => {
        if (!mounted) return
        const next = result.contracts || []
        setConfigSource(result.source || 'unknown')
        setRuntimeService(result.service || null)
        setContractsSourcePath(result.contractsSourcePath || result.configPath || null)
        setContracts(next)
        setSelectedPath((current) => next.some((item) => item.path === current) ? current : next[0]?.path || '')
      })
      .catch(() => {
        if (!mounted) return
        setConfigSource('unavailable')
        setContracts([])
        setSelectedPath('')
      })
    return () => {
      mounted = false
    }
  }, [runtimeRefreshKey])

  useEffect(() => {
    if (!preferredContractPath) return
    if (!contracts.some((contract) => contract.path === preferredContractPath)) return
    setSelectedPath(preferredContractPath)
  }, [contracts, preferredContractPath])

  useEffect(() => {
    if (preferredService === undefined) return
    setRuntimeService(preferredService || null)
  }, [preferredService])

  useEffect(() => {
    if (!selectedPath) return
    const controller = new AbortController()
    let receivedEvent = false
    setEvents([])
    setSnapshot((current) => (current?.contractPath === selectedPath ? current : null))
    setError('')
    setLoading(true)

    const loadingTimer = window.setTimeout(() => {
      if (!controller.signal.aborted && !receivedEvent) {
        setLoading(false)
      }
    }, 8000)

    function applyStructureEvent(event: ProjectStructureEvent) {
      receivedEvent = true
      setEvents((current) => [event, ...current].slice(0, 8))
      setLoading(false)
      if (event.status === 'failed' || event.error) {
        setError(event.error || event.message || 'Could not sync project structure.')
        return
      }
      const nextSnapshot = normalizeStructureSnapshot(event.snapshot)
      if (nextSnapshot) {
        setError('')
        setSnapshot(nextSnapshot)
      }
    }

    fetchLatestProjectStructure(selectedPath, runtimeService)
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.latest) {
          applyStructureEvent(result.latest)
          return
        }
        setLoading(false)
      })
      .catch(() => {
        if (!controller.signal.aborted && receivedEvent) {
          setLoading(false)
        }
      })

    readProjectStructureStream(
      selectedPath,
      applyStructureEvent,
      runtimeService,
      controller.signal,
    ).catch((streamError) => {
      if (controller.signal.aborted) return
      const message = streamError instanceof Error ? streamError.message : 'Could not read structure stream.'
      if (snapshotRef.current?.contractPath === selectedPath) {
        setEvents((current) => [{
          contractPath: selectedPath,
          service: runtimeService || undefined,
          status: 'reconnecting',
          message,
          createdAt: new Date().toISOString(),
        }, ...current].slice(0, 8))
      } else {
        setError(message)
      }
      setLoading(false)
    })

    syncProjectStructure(selectedPath, liveSync, runtimeService)
      .then((event) => {
        if (controller.signal.aborted) return
        applyStructureEvent(syncLatestEvent(event))
      })
      .catch((syncError) => {
        if (controller.signal.aborted) return
        const message = syncError instanceof Error ? syncError.message : 'Could not sync project structure.'
        if (snapshotRef.current?.contractPath === selectedPath) {
          setEvents((current) => [{
            contractPath: selectedPath,
            service: runtimeService || undefined,
            status: 'reconnecting',
            message,
            createdAt: new Date().toISOString(),
          }, ...current].slice(0, 8))
        } else {
          setError(message)
        }
        setLoading(false)
      })

    return () => {
      window.clearTimeout(loadingTimer)
      controller.abort()
    }
  }, [selectedPath, liveSync, runtimeService])

  async function toggleLiveSync() {
    const next = !liveSync
    setLiveSync(next)
    try {
      const event = await configureProjectStructureLive(selectedPath, next, runtimeService)
      setEvents((current) => [event, ...current].slice(0, 8))
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Could not update live sync.')
      setLiveSync(!next)
    }
  }

  async function refreshStructure() {
    setLoading(true)
    setError('')
    try {
      const event = await syncProjectStructure(selectedPath, liveSync, runtimeService)
      const latest = syncLatestEvent(event)
      setEvents((current) => [latest, ...current].slice(0, 8))
      const nextSnapshot = normalizeStructureSnapshot(latest.snapshot)
      if (nextSnapshot) {
        setSnapshot(nextSnapshot)
      }
      setLoading(false)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh project structure.')
      setLoading(false)
    }
  }

  async function copyPath(path: string) {
    await navigator.clipboard.writeText(path)
    setCopiedPath(path)
    window.setTimeout(() => setCopiedPath(''), 1300)
  }

  function openFileGraph(item: ContractStructureItem) {
    const graph = buildFileGraph(item, filePathSet)
    setGraphTitle(`Graph: ${item.name}`)
    setGraphNodes(graph.nodes)
    setGraphEdges(graph.edges)
    setGraphOpen(true)
  }

  function openFullGraph() {
    const graph = buildFullGraph(fileItems, filePathSet)
    setGraphTitle('Full Dependency + Function Graph')
    setGraphNodes(graph.nodes)
    setGraphEdges(graph.edges)
    setGraphOpen(true)
  }

  return (
    <section className="glass-panel app-reveal min-w-0 max-w-full overflow-hidden p-3 sm:p-5 md:p-6">
      <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[0.9rem] bg-cyan-500/12 text-cyan-200 sm:h-10 sm:w-10 sm:rounded-[1rem]">
              <FolderTree size={20} />
            </span>
            <div className="min-w-0">
              <p className="auth-kicker">File Structure</p>
              <h2 className="mt-1 truncate text-xl font-bold tracking-normal text-white sm:text-2xl">Project structure</h2>
            </div>
          </div>
          <p className="mt-3 max-w-2xl break-words text-sm leading-6 text-zinc-500">
            {selectedContract.path ? (
              <>
                {selectedContract.name} · <span className="font-mono">{selectedContract.path}</span>
              </>
            ) : (
              'Waiting for a structure-capable Orbkit runtime.'
            )}
          </p>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto_auto_auto] xl:w-[42rem]">
          <label className="relative min-w-0">
            <select
              aria-label="Select contract structure"
              className="app-select pr-10"
              disabled={contracts.length === 0}
              onChange={(event) => setSelectedPath(event.target.value)}
              value={selectedPath}
            >
              {contracts.length === 0 && <option value="">No runtime contract</option>}
              {contracts.map((contract) => (
                <option key={contract.path} value={contract.path}>
                  {contract.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500" size={16} />
          </label>
          <button
            className="auth-ghost-button inline-flex min-h-[3rem] items-center justify-center gap-2 px-3 sm:min-h-[3.2rem] sm:px-4"
            disabled={!selectedPath}
            onClick={() => void toggleLiveSync()}
            type="button"
          >
            <Activity size={16} />
            {liveSync ? 'Live On' : 'Live Off'}
          </button>
          <button
            className="auth-primary-button inline-flex min-h-[3rem] items-center justify-center gap-2 px-3 sm:min-h-[3.2rem] sm:px-4"
            disabled={loading || !selectedPath}
            onClick={() => void refreshStructure()}
            type="button"
          >
            {loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
            Sync
          </button>
          <button
            className="auth-ghost-button inline-flex min-h-[3rem] items-center justify-center gap-2 px-3 sm:min-h-[3.2rem] sm:px-4"
            disabled={fileItems.length === 0}
            onClick={openFullGraph}
            type="button"
          >
            <Network size={16} />
            Graph
          </button>
        </div>
      </div>

      <div className="mt-4 grid min-w-0 grid-cols-2 gap-2 sm:mt-5 sm:gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[
          ['Lines', snapshot?.stats.codeLines ?? 0],
          ['Functions', snapshot?.stats.functions ?? 0],
          ['Deps', snapshot?.stats.deps ?? 0],
          ['Files', snapshot?.stats.fileCount ?? fileCount],
          ['Dirs', directoryCount],
        ].map(([label, value]) => (
          <div className="min-w-0 rounded-[1rem] border border-white/10 bg-white/[0.035] p-3 sm:rounded-[1.15rem]" key={String(label)}>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-500 sm:text-xs sm:tracking-[0.2em]">{label}</p>
            <p className="mt-2 truncate text-xl font-bold text-white sm:text-2xl">{Number(value).toLocaleString()}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(15rem,17rem)]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={15} />
              <input
                className="auth-input py-3 pl-10 text-sm"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search structure"
                value={query}
              />
            </label>
            {snapshot?.manifest?.role && (
              <div className="max-w-full truncate rounded-full border border-cyan-300/20 bg-cyan-500/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-cyan-100">
                {snapshot.manifest.role}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-[1.15rem] border border-rose-300/25 bg-rose-500/10 p-4 text-sm leading-6 text-rose-100">
              {error}
            </div>
          )}

          {!error && loading && previewItems.length === 0 && (
            <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-5 text-sm text-zinc-400">
              Reading project structure...
            </div>
          )}

          {!error && !loading && previewItems.length === 0 && (
            <div className="rounded-[1.35rem] border border-white/10 bg-black/30 p-5 text-sm text-zinc-400">
              {selectedPath
                ? events.length > 0
                  ? 'Structure stream is connected, but no snapshot has arrived yet. Use Sync to request the latest project structure.'
                  : 'No structure items found.'
                : 'Start npm run orbkit with a configured contract to populate this panel.'}
            </div>
          )}

          {previewItems.length > 0 && (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {previewItems.map((item) => (
                <StructureCard
                  copied={copiedPath === item.path}
                  item={item}
                  key={item.path}
                  onCopy={(path) => void copyPath(path)}
                  onDetails={setDetailItem}
                  onGraph={openFileGraph}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="grid min-w-0 content-start gap-3">
          <div className="min-w-0 rounded-[1.15rem] border border-white/10 bg-white/[0.035] p-3">
            <div className="flex items-center gap-2">
              <GitBranch className="shrink-0 text-cyan-200" size={15} />
              <p className="text-sm font-bold text-white">Structure Stream</p>
            </div>
            <div className="app-compact-scrollbar mt-3 grid max-h-[13.5rem] gap-2 overflow-y-auto pr-1">
              {events.length === 0 && (
                <p className="text-sm leading-6 text-zinc-500">Waiting for structure events.</p>
              )}
              {events.map((event, index) => (
                <article className={`min-w-0 rounded-[0.95rem] border p-3 ${statusTone(event.status)}`} key={`${event.streamId || 'event'}-${event.sequence || index}-${index}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.14em]">{event.status || event.type || 'event'}</p>
                    <span className="shrink-0 text-[11px] text-zinc-500">{eventTime(event.createdAt)}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-zinc-300">{event.message || 'Structure stream connected.'}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="min-w-0 rounded-[1.15rem] border border-white/10 bg-white/[0.035] p-3">
            <p className="auth-kicker">Snapshot</p>
            <div className="mt-3 grid gap-2 text-sm">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">Source</p>
                <p className="mt-1 truncate text-xs text-zinc-300">{runtimeService || configSource}</p>
              </div>
              <div className="h-px bg-white/10" />
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">Config</p>
                <p className="mt-1 truncate font-mono text-xs text-zinc-400" title={contractsSourcePath || ''}>
                  {contractsSourcePath || 'pending'}
                </p>
              </div>
              <div className="h-px bg-white/10" />
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">Package</p>
                <p className="mt-1 truncate text-xs font-bold text-white">{snapshot?.manifest?.packageName || snapshot?.manifest?.binaryName || 'pending'}</p>
              </div>
              <div className="h-px bg-white/10" />
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">Entrypoints</p>
                <p className="mt-1 text-xs text-zinc-300">{snapshot?.stats.entrypointCount ?? 0}</p>
              </div>
              <div className="h-px bg-white/10" />
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">Latest</p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-300">{latestEvent?.message || 'No snapshot yet.'}</p>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
      <GraphModal
        edges={graphEdges}
        nodes={graphNodes}
        onClose={() => setGraphOpen(false)}
        open={graphOpen}
        title={graphTitle}
      />
    </section>
  )
}
