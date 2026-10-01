/**
 * Adapted from DeepSeek Harness ui-settings-general SettingsRoot and
 * ui-primitives useModalLayer. Copyright (c) 2026 DeepSeek, MIT License.
 * This is a framework-neutral presentation shell; section content is supplied by the caller.
 */
import { useId, useLayoutEffect, useRef } from 'react'
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './primitives/cx'
import { focusWithoutRing } from './primitives/focus'
import css from './SettingsPanel.module.css'

export type SettingsPanelSection = {
  id: string
  label: string
  icon?: ReactNode
  content: ReactNode
}

export type SettingsPanelProps = {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  sections: readonly SettingsPanelSection[]
  selectedId?: string
  onSelect: (id: string) => void
  closeLabel: string
}

const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

/** Accessible, portal-mounted settings dialog with a responsive section navigator. */
export function SettingsPanel({ open, onClose, title, sections, selectedId, onSelect, closeLabel }: SettingsPanelProps) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const selected = sections.find(section => section.id === selectedId)?.id ?? sections[0]?.id

  useLayoutEffect(() => {
    const element = panel.current
    if (!open || element === null) return
    const doc = element.ownerDocument
    const overlay = element.parentElement
    const previous = doc.activeElement
    const inertStates = [...doc.body.children]
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child !== overlay)
      .map(child => ({ child, inert: child.inert }))
    for (const { child } of inertStates) child.inert = true
    const initial = element.querySelector<HTMLElement>('[data-modal-autofocus]')
      ?? element.querySelector<HTMLElement>(focusable) ?? element
    if (!element.contains(doc.activeElement)) focusWithoutRing(initial)

    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault()
        if (!event.repeat) closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...element.querySelectorAll<HTMLElement>(focusable)].filter(item => {
        if (item.tabIndex < 0 || item.closest('[inert], [hidden]')) return false
        const style = doc.defaultView?.getComputedStyle(item)
        return style?.display !== 'none' && style?.visibility !== 'hidden'
      })
      const first = items[0] ?? element
      const last = items.at(-1) ?? element
      const atEdge = event.shiftKey ? doc.activeElement === first : doc.activeElement === last
      if (doc.activeElement === element || !element.contains(doc.activeElement) || atEdge) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) {
        const destination = element.querySelector<HTMLElement>('[data-modal-autofocus]')
          ?? element.querySelector<HTMLElement>(focusable) ?? element
        focusWithoutRing(destination)
      }
    }
    doc.addEventListener('keydown', keydown)
    doc.addEventListener('focusin', focusin)
    return () => {
      doc.removeEventListener('keydown', keydown)
      doc.removeEventListener('focusin', focusin)
      for (const { child, inert } of inertStates) child.inert = inert
      if (previous instanceof HTMLElement && previous.isConnected) focusWithoutRing(previous)
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null
  const active = sections.find(section => section.id === selected)
  const activeIndex = sections.findIndex(section => section.id === selected)
  const moveTab = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key) || sections.length === 0) return
    event.preventDefault()
    const backwards = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (activeIndex + (backwards ? -1 : 1) + sections.length) % sections.length
    const section = sections[next]
    if (section) {
      onSelect(section.id)
      requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>(`[data-section="${CSS.escape(section.id)}"]`)?.focus())
    }
  }

  return createPortal(
    <div className={css.overlay}>
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div ref={panel} tabIndex={-1} className={css.panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <nav className={css.nav} aria-label={typeof title === 'string' ? title : undefined}>
          <div className={css.title} id={`${id}-title`}>{title}</div>
          <div className={css.navList} role="tablist" aria-orientation="vertical">
            {sections.map(section => <button
              key={section.id} type="button" role="tab" data-section={section.id}
              id={`${id}-tab-${section.id}`} aria-controls={`${id}-panel-${section.id}`}
              aria-selected={section.id === selected} tabIndex={section.id === selected ? 0 : -1}
              data-modal-autofocus={section.id === selected ? '' : undefined}
              className={cx(css.navItem, section.id === selected && css.selected)}
              onClick={() => onSelect(section.id)} onKeyDown={moveTab}
            >{section.icon && <span className={css.icon}>{section.icon}</span>}<span>{section.label}</span></button>)}
          </div>
        </nav>
        <section className={css.content} role="tabpanel" id={active ? `${id}-panel-${active.id}` : undefined}
          aria-labelledby={active ? `${id}-tab-${active.id}` : undefined}>
          <header className={css.header}>
            <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}><span aria-hidden="true">×</span></button>
          </header>
          <div className={css.body}>{active?.content}</div>
        </section>
      </div>
    </div>, document.body,
  )
}
