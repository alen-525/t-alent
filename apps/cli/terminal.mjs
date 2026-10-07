import readline from 'node:readline'
import { stripVTControlCharacters } from 'node:util'

const ESC = '\u001b['
const C = { reset: '\u001b[0m', dim: '\u001b[2m', gray: '\u001b[90m', cyan: '\u001b[36m', green: '\u001b[32m' }

export function makeTerminal({ input = process.stdin, output = process.stdout, color = true } = {}) {
  const tty = Boolean(input.isTTY && output.isTTY)
  const useColor = color !== false && !Object.hasOwn(process.env, 'NO_COLOR') && output.isTTY
  const paint = (value, style) => useColor ? `${style}${value}${C.reset}` : value
  const write = value => output.write(String(value))
  const width = () => Math.max(20, output.columns || 80)
  const colorize = (value, style) => paint(value, style)

  function line(text = '') { write(`${text}\n`) }
  function clearLine() { if (tty) write(`\r${ESC}2K`) }
  function safe(value) {
    return stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ch => ch === '\n' || ch === '\t' ? ch : '')
  }
  function fit(text, max) {
    let out = '', used = 0
    for (const ch of text) {
      const w = visible(ch)
      if (used + w > max) break
      out += ch; used += w
    }
    return { text: out, width: used }
  }
  function brand({ identity, rows = [], title = 't-alent CLI', compact = false } = {}) {
    const mark = safe(identity?.mark || '✳')
    const label = safe(identity?.label || 't-alent')
    const icon = identity?.ansi ? paint(mark, identity.ansi) : mark
    const art = (identity?.art || []).slice(0, 7).map(row => safe(row))
    const artWidth = Math.min(15, Math.max(0, ...art.map(row => visible(row))))
    const required = artWidth + Math.max(0, ...rows.map(row => visible(safe(row)))) + 8
    if (compact || width() < 64 || width() < required || !art.length) {
      const limit = Math.max(1, width() - 1)
      const headline = splitDisplay(`${mark} ${label} · ${safe(title)}`, limit)
      headline.forEach((part, index) => {
        const rendered = index === 0 && part.startsWith(mark) ? `${icon}${part.slice(mark.length)}` : part
        line(rendered)
      })
      for (const row of rows) {
        for (const part of splitDisplay(safe(row), limit)) line(part)
      }
      return
    }
    const outerWidth = width() - 1
    const rightWidth = outerWidth - artWidth - 7
    const count = Math.max(art.length, rows.length)
    const shownTitle = fit(safe(title), Math.max(1, outerWidth - 5))
    line(colorize(`╭─ ${shownTitle.text} ${'─'.repeat(Math.max(0, outerWidth - shownTitle.width - 5))}╮`, C.gray))
    for (let i = 0; i < count; i++) {
      const artRow = fit(art[i] || '', artWidth)
      const artPad = Math.max(0, artWidth - artRow.width)
      const info = fit(safe(rows[i] || ''), rightWidth)
      line(`${colorize('│', C.gray)} ${colorize(artRow.text, identity?.ansi || C.cyan)}${' '.repeat(artPad)} ${colorize('│', C.gray)} ${info.text}${' '.repeat(Math.max(0, rightWidth - info.width))} ${colorize('│', C.gray)}`)
    }
    line(colorize(`╰${'─'.repeat(outerWidth - 2)}╯`, C.gray))
  }
  function splitDisplay(text, limit) {
    const out = []
    let row = '', cells = 0
    for (const ch of text) {
      const w = visible(ch)
      if (cells + w > limit && row) { out.push(row); row = ''; cells = 0 }
      row += ch; cells += w
    }
    if (row || !out.length) out.push(row)
    return out
  }
  function visible(s) {
    const raw = stripVTControlCharacters(String(s))
    let n = 0
    for (const ch of raw) n += /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u.test(ch) ? 2 : 1
    return n
  }

  let promptRows = 0, promptCursorRow = 0
  function renderPrompt(value, cursor, prefix = '› ') {
    if (!tty) return
    const rows = value.split('\n')
    if (promptRows) {
      write('\r')
      if (promptCursorRow > 0) write(`${ESC}${promptCursorRow}A`)
      for (let i = 0; i < promptRows; i++) { write(`${ESC}2K`); if (i < promptRows - 1) write(`${ESC}1B`) }
      if (promptRows > 1) write(`\r${ESC}${promptRows - 1}A`)
    }
    const before = value.slice(0, cursor)
    promptCursorRow = before.split('\n').length - 1
    const local = before.length - (before.lastIndexOf('\n') + 1)
    const shown = []
    rows.forEach((row, i) => {
      const mark = i === 0 ? prefix : '· '
      const raw = safe(row)
      const available = Math.max(1, width() - visible(mark) - 1)
      let offset = 0
      if (i === promptCursorRow) {
        while (offset < local && visible(raw.slice(offset, local)) >= available) offset = nextCodePoint(raw, offset)
      }
      const lead = offset ? '…' : ''
      const fitted = fit(raw.slice(offset), available - visible(lead))
      shown.push({ mark, text: fitted.text, offset, lead })
      if (i) write('\r\n')
      write(`${colorize(mark, C.cyan)}${lead}${fitted.text}`)
    })
    promptRows = rows.length
    const moveUp = rows.length - 1 - promptCursorRow
    if (moveUp > 0) write(`${ESC}${moveUp}A`)
    write('\r')
    const cursorRow = shown[promptCursorRow]
    const cursorCol = visible(cursorRow.mark) + visible(cursorRow.lead) + visible(cursorRow.text.slice(0, Math.max(0, local - cursorRow.offset)))
    if (cursorCol > 0) write(`${ESC}${cursorCol}C`)
  }

  function readLine({ initial = '', history = [], select = null, onInterrupt, signal, prefix = '› ' } = {}) {
    if (!tty) {
      return new Promise(resolve => {
        const rl = readline.createInterface({ input, output, terminal: false, history: [...history].reverse() })
        rl.question('> ', answer => { rl.close(); resolve({ value: answer, history: rl.history || [] }) })
      })
    }
    return new Promise(resolve => {
      const oldRaw = input.isRaw
      input.resume?.()
      if (typeof input.setRawMode === 'function') input.setRawMode(true)
      readline.emitKeypressEvents(input)
      let value = initial, cursor = initial.length, histIndex = -1, draft = ''
      let selector = select ? { ...select, index: Math.max(0, select.index || 0), offset: 0, maxItems: Math.max(1, (output.rows || 24) - 7) } : null
      let selectorRows = 0
      let settled = false
      const redraw = () => {
        if (selector) {
          if (selectorRows) write(`\r${ESC}${selectorRows}A`)
          for (let i = 0; i < selectorRows; i++) write(`\r${ESC}2K${i < selectorRows - 1 ? `${ESC}1B` : ''}`)
          if (selectorRows > 1) write(`\r${ESC}${selectorRows - 1}A`)
          clearLine()
          line(colorize(fit(safe(`› ${selector.title}  ↑/↓  Enter  Esc`), width() - 1).text, C.cyan))
          const visibleItems = selector.items.slice(selector.offset, selector.offset + selector.maxItems)
          visibleItems.forEach((item, i) => line(`${selector.offset + i === selector.index ? colorize('❯', C.cyan) : ' '} ${fit(safe(item).replace(/\s+/g, ' '), width() - 3).text}`))
          selectorRows = visibleItems.length + 1
          renderPrompt(value, cursor, prefix)
        } else renderPrompt(value, cursor, prefix)
      }
      const finish = result => {
        if (settled) return
        settled = true
        input.off('keypress', onKey)
        input.off('end', onEnd)
        input.off('close', onEnd)
        signal?.removeEventListener('abort', onAbort)
        if (typeof input.setRawMode === 'function') input.setRawMode(Boolean(oldRaw))
        if (promptRows) {
          const down = promptRows - 1 - promptCursorRow
          if (down > 0) write(`${ESC}${down}B`)
          write('\r'); line('')
          promptRows = 0; promptCursorRow = 0
        } else { clearLine(); line('') }
        input.pause?.()
        resolve(result)
      }
      const onEnd = () => finish({ value: '', interrupted: true, history })
      const onAbort = () => finish({ value: '', interrupted: true, history })
      const onKey = (str, key = {}) => {
        if (selector) {
          if (key.name === 'up') selector.index = (selector.index + selector.items.length - 1) % selector.items.length
          else if (key.name === 'down') selector.index = (selector.index + 1) % selector.items.length
          else if (key.name === 'return' || key.name === 'enter') { const chosen = selector.items[selector.index]; finish({ value: chosen ?? '', selected: selector.index, history }); return }
          else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { finish({ value: '', cancelled: true, history }); return }
          selector.offset = Math.max(0, Math.min(selector.index, Math.max(0, selector.items.length - selector.maxItems)))
          redraw(); return
        }
        if (key.ctrl && key.name === 'c') { if (onInterrupt) { onInterrupt(); finish({ value: '', interrupted: true, history }); return } finish({ value: '', interrupted: true, history }); return }
        else if (str === '\n' || (key.ctrl && (key.name === 'j' || key.name === 'enter' || key.name === 'return'))) { value = value.slice(0, cursor) + '\n' + value.slice(cursor); cursor++; redraw(); return }
        else if (key.name === 'return' || key.name === 'enter') {
          if (key.shift) { value = value.slice(0, cursor) + '\n' + value.slice(cursor); cursor++; redraw(); return }
          renderPrompt(value, value.length, prefix)
          finish({ value, history: value.trim() ? [value.trim(), ...history.filter(x => x !== value.trim())].slice(0, 100) : history }); return
        }
        else if (key.ctrl && key.name === 'd' && !value) { finish({ value: '', interrupted: true, history }); return }
        else if (key.name === 'up' && !value.includes('\n')) {
          if (history.length) { if (histIndex < 0) draft = value; histIndex = Math.min(history.length - 1, histIndex + 1); value = history[histIndex]; cursor = value.length }
        } else if (key.name === 'down' && histIndex >= 0) {
          histIndex--; value = histIndex < 0 ? draft : history[histIndex]; cursor = value.length
        } else if (key.name === 'left') cursor = previousCodePoint(value, cursor)
        else if (key.name === 'right') cursor = nextCodePoint(value, cursor)
        else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = value.lastIndexOf('\n', cursor - 1) + 1
        else if (key.name === 'end' || (key.ctrl && key.name === 'e')) { const n = value.indexOf('\n', cursor); cursor = n < 0 ? value.length : n }
        else if (key.name === 'backspace') { if (cursor) { const start = previousCodePoint(value, cursor); value = value.slice(0, start) + value.slice(cursor); cursor = start } }
        else if (key.name === 'delete') value = value.slice(0, cursor) + value.slice(nextCodePoint(value, cursor))
        else if (key.name === 'tab') {
          const before = value.slice(0, cursor)
          if (before.startsWith('/')) {
            const cmds = ['/help', '/harness', '/model', '/new', '/status', '/clear', '/resume', '/quit']
            const token = before.split(/\s/).at(-1)
            const matches = cmds.filter(x => x.startsWith(token))
            if (matches.length === 1) { const next = value.slice(0, cursor - token.length) + matches[0] + value.slice(cursor); value = next; cursor += matches[0].length - token.length }
            else if (matches.length) { clearLine(); line(matches.join('  ')) }
          }
        } else if (str && !key.ctrl && !key.meta && str >= ' ') { value = value.slice(0, cursor) + str; cursor += str.length }
        redraw()
      }
      input.on('keypress', onKey)
      input.once('end', onEnd)
      input.once('close', onEnd)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      redraw()
    })
  }

  let assistantRows = 0, previewText = '', taskStatus = ''
  function wrapText(text, columns) {
    const lines = []
    for (const source of text.split('\n')) {
      let lineText = '', used = 0
      for (const ch of source) {
        const w = visible(ch)
        if (used + w > columns && lineText) { lines.push(lineText); lineText = ''; used = 0 }
        lineText += ch; used += w
      }
      lines.push(lineText)
    }
    return lines
  }
  function erasePreview() {
    if (!tty || !assistantRows) return
    write('\r')
    if (assistantRows > 1) write(`${ESC}${assistantRows - 1}A`)
    for (let i = 0; i < assistantRows; i++) { write(`${ESC}2K`); if (i < assistantRows - 1) write(`${ESC}1B`) }
    if (assistantRows > 1) write(`\r${ESC}${assistantRows - 1}A`)
    assistantRows = 0
  }
  function renderPreview() {
    if (!tty) return
    erasePreview()
    const maxRows = Math.max(2, (output.rows || 24) - 3)
    const bodyLimit = maxRows - (taskStatus ? 1 : 0)
    const allLines = previewText ? wrapText(previewText, Math.max(1, width() - 3)) : []
    const body = allLines.length > bodyLimit ? ['…', ...allLines.slice(-(bodyLimit - 1))] : allLines
    const rows = body.map((text, i) => `${i ? '  ' : colorize('• ', C.green)}${text}`)
    if (taskStatus) rows.push(colorize(fit(taskStatus, width() - 1).text, C.dim))
    rows.forEach((text, i) => write(`${i ? '\r\n' : ''}${text}`))
    assistantRows = rows.length
  }
  function replaceCurrent(text) {
    previewText = safe(text)
    renderPreview()
  }
  function previousCodePoint(value, index) { if (index <= 0) return 0; const code = value.charCodeAt(index - 1); return code >= 0xdc00 && code <= 0xdfff && index > 1 ? index - 2 : index - 1 }
  function nextCodePoint(value, index) { if (index >= value.length) return value.length; const code = value.charCodeAt(index); return code >= 0xd800 && code <= 0xdbff && index + 1 < value.length ? index + 2 : index + 1 }
  function commitCurrent() {
    if (!tty) return
    erasePreview()
    if (previewText) wrapText(previewText, Math.max(1, width() - 3)).forEach((text, i) => line(`${i ? '  ' : colorize('• ', C.green)}${text}`))
    previewText = ''; taskStatus = ''
  }
  function clearCurrent() { erasePreview(); previewText = ''; taskStatus = '' }
  function status(text) { taskStatus = safe(text); renderPreview() }

  return { tty, input, output, width, colorize, safe, visible, line, brand, readLine, renderPrompt, replaceCurrent, commitCurrent, clearCurrent, clearLine, status }
}
