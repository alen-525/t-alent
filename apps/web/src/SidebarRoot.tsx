/**
 * Adapted from DeepSeek Harness' sidebar shell (MIT), with DSH runtime and
 * desktop integrations replaced by ordinary React props.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { House, Package, PanelLeftClose, PanelLeftOpen, Plus, Settings2 } from 'lucide-react'
import css from './SidebarRoot.module.css'

/** Localized text used by the sidebar shell and its empty workspace region. */
export type SidebarLabels = {
  newSession: string
  openSidebar: string
  collapseSidebar: string
  panels: string
  settings: string
  packages: string
  models: string
  home: string
  workspace: string
  recent: string
  noConversations: string
}

/** A navigation row supplied by the application. */
export type SidebarPanel = {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
}

/** Props for the standalone sidebar shell. */
export type SidebarRootProps = {
  collapsed: boolean
  width: number
  onToggle: () => void
  onNewSession: () => void
  onHome: () => void
  labels: SidebarLabels
  activePanel: string
  panels: readonly SidebarPanel[]
  onSettings: () => void
  region?: ReactNode
}

/** Wide-content unmount delay; matches the 150ms collapse crossfade. */
const COLLAPSE_SETTLE_MS = 150

/** Keep the sidebar scrollbar visible briefly after the pointer leaves. */
const SCROLLBAR_LINGER_MS = 2000

function PanelRow({
  label, icon, active, wide, onSelect,
}: SidebarPanel & { active: boolean; wide: boolean }) {
  return (
    <button
      type="button"
      className={`${css.panelRow} ${active ? css.panelActive : ''}`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={wide ? undefined : label}
      onClick={onSelect}
    >
      <span className={css.panelGlyph} aria-hidden="true">
        {icon ?? <House size={wide ? 16 : 18} />}
      </span>
      {wide && <span className={`${css.panelTitle} ${css.wide}`}>{label}</span>}
    </button>
  )
}

/** Render a responsive sidebar with a frozen-width collapse transition. */
export function SidebarRoot({
  collapsed, width, onToggle, onNewSession, onHome, labels, activePanel, panels, onSettings, region,
}: SidebarRootProps) {
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) {
      setSettled(false)
      return
    }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])

  const wide = !collapsed || !settled
  const panelLabel = (panel: SidebarPanel): string => panel.id === 'home'
    ? labels.home
    : panel.id === 'packages' ? labels.packages : panel.id === 'models' ? labels.models : panel.label
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  const column = useRef<HTMLElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }

  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  return (
    <aside
      ref={column}
      className={`${css.root} ${!wide ? css.collapsed : ''} ${!wide && everWide.current ? css.railIn : ''} ${collapsed && wide ? css.fading : ''} ${!pointerInside ? css.quietBars : ''}`}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      aria-label={labels.panels}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={armLinger}
    >
      <div className={css.logoRow}>
        {wide && (
          <button type="button" className={`${css.brand} ${css.wide}`} aria-label={labels.home} onClick={onHome}>
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}><span className={css.wordmark}>t</span></span>
              <span className={css.brandName}>t-alent</span>
            </span>
          </button>
        )}
        <button
          type="button"
          className={`${css.iconButton} ${css.toggle}`}
          aria-label={collapsed ? labels.openSidebar : labels.collapseSidebar}
          title={collapsed ? labels.openSidebar : labels.collapseSidebar}
          onClick={onToggle}
        >
          {!wide && <span className={css.railMark} aria-hidden="true"><span className={css.wordmark}>t</span></span>}
          {collapsed ? <PanelLeftOpen className={css.panelIcon} size={wide ? 16 : 18} /> : <PanelLeftClose className={css.panelIcon} size={16} />}
        </button>
      </div>

      <button type="button" className={css.newSession} aria-label={labels.newSession} title={wide ? undefined : labels.newSession} onClick={onNewSession}>
        <span className={css.newSessionLabelMask}>
          <span className={css.newSessionContent}>
            <Plus size={wide ? 16 : 18} />
            {wide && <span className={`${css.newSessionLabel} ${css.wide}`}>{labels.newSession}</span>}
          </span>
        </span>
      </button>

      {panels.length > 0 && (
        <nav className={css.panelList} aria-label={labels.panels}>
          {panels.map(panel => (
            <PanelRow
              key={panel.id}
              {...panel}
              label={panelLabel(panel)}
              icon={panel.icon ?? (panel.id === 'packages' ? <Package size={wide ? 16 : 18} /> : <House size={wide ? 16 : 18} />)}
              wide={wide}
              active={activePanel === panel.id}
            />
          ))}
        </nav>
      )}

      <div className={css.regionArea}>
        {region ?? (
          <div className={css.defaultRegion}>
            <div className={css.regionHeading}>{labels.workspace}</div>
            <div className={css.recentHeading}>{labels.recent}</div>
            <div className={css.emptyRegion}>{labels.noConversations}</div>
          </div>
        )}
      </div>

      <div className={css.footArea}>
        <div className={css.footerActions} />
        <div className={css.settingsArea}>
          <button
            type="button"
            className={css.panelRow}
            aria-label={labels.settings}
            aria-current={activePanel === 'settings' ? 'page' : undefined}
            title={wide ? undefined : labels.settings}
            onClick={onSettings}
          >
            <span className={css.panelGlyph} aria-hidden="true"><Settings2 size={16} /></span>
            {wide && <span className={`${css.panelTitle} ${css.wide}`}>{labels.settings}</span>}
          </button>
        </div>
      </div>
    </aside>
  )
}
