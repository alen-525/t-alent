/**
 * Adapted from DeepSeek Harness packages/client/ui-layout/src/client/AppFrame.tsx.
 * Keeps the original three-column frame and pointer-capture resizing behavior;
 * plugin slots and harness stores are replaced by plain React children/callbacks.
 * Copyright (c) DeepSeek. Licensed under MIT; see the repository's LICENSE.DeepSeek.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { clampWidth, computeColumns, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MIN, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT } from './columns'
import css from './AppFrame.module.css'

function DragHandle({ side, left, onStart, onDrag, onEnd }: { side: 'sidebar' | 'rightbar'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart, onDrag, onEnd })
  callbacks.current = { onStart, onDrag, onEnd }
  const endDrag = useCallback(() => {
    const active = capture.current
    if (!active) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false); callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])
  return <div className={css.handle} style={{ left }} data-side={side} data-dragging={dragging || undefined}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); capture.current = { element: event.currentTarget, id: event.pointerId }; origin.current = event.clientX; callbacks.current.onStart(); setDragging(true) }}
    onPointerMove={event => { if (capture.current?.id !== event.pointerId) return; latest.current = event.clientX; frame.current ??= requestAnimationFrame(() => { frame.current = null; callbacks.current.onDrag(latest.current - origin.current) }) }}
    onPointerUp={event => { if (capture.current?.id === event.pointerId) { callbacks.current.onDrag(event.clientX - origin.current); endDrag() } }}
    onPointerCancel={endDrag} onLostPointerCapture={endDrag} />
}

export function AppFrame({ sidebar, main, rightbar, rightbarOpen = false, onSidebarWidth, onRightbarWidth, onToggleSidebar, sidebarCollapsed = false }: {
  sidebar: (state: { collapsed: boolean; width: number; onToggle: () => void }) => ReactNode
  main: ReactNode
  rightbar?: ReactNode
  rightbarOpen?: boolean
  sidebarCollapsed?: boolean
  onSidebarWidth?: (width: number) => void
  onRightbarWidth?: (width: number) => void
  onToggleSidebar?: () => void
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState(typeof window === 'undefined' ? 1280 : window.innerWidth)
  const [sidebarWidth, setSidebar] = useState(SIDEBAR_DEFAULT)
  const [rightbarWidth, setRightbar] = useState(0)
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const collapsed = narrow ? !narrowExpanded : sidebarCollapsed
  const cols = computeColumns(viewport, collapsed ? 0 : sidebarWidth, rightbarOpen ? rightbarWidth || viewport * RIGHTBAR_DEFAULT_RATIO : 0)
  const colsRef = useRef(cols); colsRef.current = cols
  const rightbarRenderedWidth = cols.rightbar
  const sidebarBase = useRef(0); const rightbarBase = useRef(0)
  useLayoutEffect(() => {
    const element = frameRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.getBoundingClientRect().width))
    observer.observe(element); setViewport(element.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => { const value = clampWidth(sidebarBase.current + dx, 264, 420); setSidebar(value); onSidebarWidth?.(value) }, [onSidebarWidth])
  const onRightbarStart = useCallback(() => { rightbarBase.current = rightbarRenderedWidth; setDragging(true) }, [rightbarRenderedWidth])
  const onRightbarDrag = useCallback((dx: number) => { const value = clampWidth(rightbarBase.current - dx, RIGHTBAR_MIN, viewport * .7); setRightbar(value); onRightbarWidth?.(value) }, [onRightbarWidth, viewport])
  const toggleSidebar = () => narrow ? setNarrowExpanded(value => !value) : onToggleSidebar?.()
  return <div ref={frameRef} className={css.frame} style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0,1fr) minmax(0,${rightbarRenderedWidth}px)` }} data-sidebar-collapsed={collapsed || undefined} data-rightbar-collapsed={!rightbarOpen || undefined} data-rightbar-open={rightbarOpen || undefined} data-rightbar-overlay={rightbarOpen && cols.rightbar === 0 || undefined} data-dragging={dragging || undefined}>
    <div className={css.sidebarCol}>{sidebar({ collapsed, width: cols.sidebar, onToggle: toggleSidebar })}</div>
    <div className={css.centerCol}>{main}</div><div className={css.rightbarCol}>{rightbarOpen && rightbar}</div>
    {!collapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={() => setDragging(false)} />}
    {rightbarOpen && rightbarRenderedWidth > 0 && <DragHandle side="rightbar" left={viewport - rightbarRenderedWidth} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={() => setDragging(false)} />}
  </div>
}
