/** Focus a modal destination without a focus ring until keyboard navigation or blur. */
const navigationKeys = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

export function focusWithoutRing(element: HTMLElement): void {
  const release = () => {
    element.removeAttribute('data-talent-auto-focus')
    element.removeEventListener('blur', release)
    element.removeEventListener('keydown', navigate, true)
  }
  const navigate = (event: KeyboardEvent) => {
    if (!event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && navigationKeys.has(event.key)) release()
  }
  element.setAttribute('data-talent-auto-focus', '')
  element.addEventListener('blur', release, { once: true })
  element.addEventListener('keydown', navigate, true)
  element.focus()
  if (!element.matches(':focus')) release()
}
