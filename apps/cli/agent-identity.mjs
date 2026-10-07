function ansi(accent) {
  const hex = accent.slice(1)
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return `\u001b[38;2;${red};${green};${blue}m`
}

function circleArt(inside) {
  const center = value => {
    const text = Array.from(value).slice(0, 9).join('')
    const width = Array.from(text).length
    const left = Math.floor((9 - width) / 2)
    return `${' '.repeat(left)}${text}${' '.repeat(9 - width - left)}`
  }
  return [
    '     .---.     ',
    "   .'     '.   ",
    `  /${center(inside[0])}\\  `,
    `  |${center(inside[1])}|  `,
    `  \\${center(inside[2])}/  `,
    "   '.     .'   ",
    "     '---'     ",
  ]
}

function identity(id, label, mark, accent, inside) {
  const rows = circleArt(inside)
  return Object.freeze({ id, label, mark, accent, ansi: ansi(accent), art: Object.freeze(rows) })
}

export const AGENT_IDENTITIES = Object.freeze({
  codex: identity('codex', 'Codex', '>_', '#AEB8C6', ['         ', '   >_    ', '         ']),
  deepseek: identity('deepseek', 'DeepSeek', '~>', '#70B9D2', ['   __    ', '(o)~~~>  ', '  ~~~~~  ']),
  pi: identity('pi', 'Pi', 'π', '#E8C27A', ['', 'π', '']),
  opencode: identity('opencode', 'OpenCode', '</>', '#D3DAE4', ['<       >', ' </>     ', '         ']),
  gemini: identity('gemini', 'Gemini', '✦', '#B9A6E8', ['    ^    ', ' <  *  > ', '    v    ']),
  goose: identity('goose', 'Goose', '^>', '#D7B86C', ['   __    ', '  >(o)>  ', '   /     ']),
  cline: identity('cline', 'Cline', '[=]', '#72C3BD', [' .-----. ', '[|=|=|=|]', ' `--.--` ']),
  qwen: identity('qwen', 'Qwen', 'Q', '#C3A8FF', ['', '< Q >', '']),
  kilo: identity('kilo', 'Kilo', 'K>', '#F2C94C', ['', 'K >', '']),
  continue: identity('continue', 'Continue', 'CN', '#7ACD9B', ['', 'C > >', '']),
  aider: identity('aider', 'Aider', 'AI', '#8CAFCB', ['', 'A I', '']),
  openclaw: identity('openclaw', 'OpenClaw', 'OC', '#E98074', ['\\       /', 'O C', '/       \\']),
  openhands: identity('openhands', 'OpenHands', 'OH', '#9EB8FB', ['<       >', 'O H', '']),
  'mini-swe-agent': identity('mini-swe-agent', 'mini-SWE', 'MS', '#CD91B3', ['', 'm SWE', '']),
  deepagents: identity('deepagents', 'Deep Agents', 'DA', '#BCB875', ['[       ]', 'D A', '']),
  'mistral-vibe': identity('mistral-vibe', 'Mistral Vibe', 'MV', '#F0AD73', ['', 'M V', '']),
  'swe-agent': identity('swe-agent', 'SWE-agent', 'SW', '#A6C9A5', ['', 'S W E', '']),
  'open-interpreter': identity('open-interpreter', 'Open Interpreter', 'OI', '#D4C0AE', ['', 'O I', '']),
  'roo': identity('roo', 'Roo Code', 'R>', '#77B8C8', ['', 'R>', '']),
  'nanobot': identity('nanobot', 'nanobot', 'NB', '#9CC9B0', ['', 'NB', '']),
  'smolagents': identity('smolagents', 'smolagents', 'SM', '#EBC66A', ['', 'SM', '']),
  'magentic-one': identity('magentic-one', 'Magentic-One', 'M1', '#92B8E6', ['', 'M 1', '']),
  'crewai': identity('crewai', 'CrewAI', 'CR', '#DD9B86', ['', 'C R', '']),
  'hermes': identity('hermes', 'Hermes Agent', 'HM', '#BDACD9', ['', 'H M', '']),
  talent: identity('talent', 't-alent', 't-', '#AEB8C6', ['         ', '    t-   ', '         ']),
})

export function getAgentIdentity(manifest) {
  const id = typeof manifest === 'string' ? manifest : manifest?.id
  if (!id) return AGENT_IDENTITIES.talent
  const rawId = String(id)
  if (Object.hasOwn(AGENT_IDENTITIES, rawId)) return AGENT_IDENTITIES[rawId]
  const safeId = rawId.replace(/[^A-Za-z0-9._@/-]/g, '').slice(0, 120)
  if (!safeId) return AGENT_IDENTITIES.talent
  const segment = safeId.split(/[/.@_-]/).filter(Boolean).at(-1) || safeId
  const label = segment.slice(0, 48)
  const mark = segment.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'TA'
  return identity(safeId, label, mark, AGENT_IDENTITIES.talent.accent, ['', mark, ''])
}
