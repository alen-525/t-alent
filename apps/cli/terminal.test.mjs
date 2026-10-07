import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTerminal } from './terminal.mjs'

class TinyTerminal {
  constructor(rows, columns) {
    this.rows = rows
    this.columns = columns
    this.row = 0
    this.column = 0
    this.screen = Array.from({ length: rows }, () => Array(columns).fill(' '))
    this.scrollback = []
    this.isTTY = true
    this.isRaw = false
  }

  setRawMode(value) { this.isRaw = value }

  write(chunk) {
    const text = String(chunk)
    for (let i = 0; i < text.length;) {
      if (text[i] === '\u001b' && text[i + 1] === '[') {
        let end = i + 2
        while (end < text.length && !(text.charCodeAt(end) >= 0x40 && text.charCodeAt(end) <= 0x7e)) end++
        const command = text[end]
        const parameters = text.slice(i + 2, end).split(';').map(value => Number.parseInt(value, 10) || 0)
        const amount = parameters[0] || 1
        if (command === 'A') this.row = Math.max(0, this.row - amount)
        else if (command === 'B') this.row = Math.min(this.rows - 1, this.row + amount)
        else if (command === 'C') this.column = Math.min(this.columns - 1, this.column + amount)
        else if (command === 'D') this.column = Math.max(0, this.column - amount)
        else if (command === 'K' && (parameters[0] === 2 || parameters[0] === 0)) {
          const from = parameters[0] === 0 ? this.column : 0
          for (let col = from; col < this.columns; col++) this.screen[this.row][col] = ' '
        }
        // SGR is intentionally ignored; unsupported CSI sequences have no effect.
        i = end + 1
        continue
      }
      const char = text[i++]
      if (char === '\r') { this.column = 0; continue }
      if (char === '\n') { this.lineFeed(); continue }
      if (char === '\u001b') continue
      if (this.column >= this.columns) this.lineFeed()
      this.screen[this.row][this.column++] = char
    }
    return true
  }

  lineFeed() {
    this.column = 0
    if (this.row < this.rows - 1) { this.row++; return }
    this.scrollback.push(this.screen.shift().join(''))
    this.screen.push(Array(this.columns).fill(' '))
  }

  get text() { return [...this.scrollback, ...this.screen.map(row => row.join(''))].join('\n') }
}

test('long assistant previews replace in place while committed history remains visible', { timeout: 5000 }, () => {
  const input = { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value } }
  const output = new TinyTerminal(12, 40)
  const terminal = makeTerminal({ input, output, color: true })

  terminal.line('TOOL_HISTORY')
  for (let i = 0; i < 20; i++) terminal.line(`tool_event_${i}`)
  const reply = Array.from({ length: 50 }, (_, i) => `line_${i}`).join('\n')
  terminal.replaceCurrent(reply)
  terminal.status('Working')
  const corrected = Array.from({ length: 50 }, (_, i) => `corrected_${i}`).join('\n')
  terminal.replaceCurrent(corrected)
  terminal.status('')
  terminal.commitCurrent()
  terminal.line('PROMPT')

  const rendered = output.text
  const visibleRows = rendered.split('\n').map(row => row.replace(/^• /, '').trimEnd())
  assert.match(rendered, /TOOL_HISTORY/)
  assert.match(rendered, /PROMPT/)
  assert.doesNotMatch(rendered, /Working|line_\d+/)
  for (let i = 0; i < 50; i++) {
    const expected = `corrected_${i}`
    const occurrences = visibleRows.filter(row => row.trim().replace(/^•\s*/, '') === expected).length
    assert.equal(occurrences, 1, `${expected} should appear exactly once in visible transcript`)
  }
})
