import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AGENT_IDENTITIES } from '../apps/cli/agent-identity.mjs'
import { ADAPTERS } from '../packages/runtime/adapters/registry.mjs'

const root = new URL('../', import.meta.url)
const ids = [...Object.keys(ADAPTERS), 'talent']
const width = 1024, height = 158 + Math.ceil(ids.length / 4) * 202
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const cards = []
for (const [index, id] of ids.entries()) {
  const identity = AGENT_IDENTITIES[id]
  if (!identity) throw new Error(`Missing registered agent identity: ${id}`)
  const asset = await readFile(new URL(`apps/cli/assets/icons/${id}.svg`, root), 'utf8')
  const viewBox = /viewBox="([^"]+)"/.exec(asset)?.[1]
  if (!viewBox) throw new Error(`Missing icon viewBox: ${id}`)
  const contents = asset.replace(/^.*?<svg\b[^>]*>/s, '').replace(/<\/svg>\s*$/, '')
  const x = 32 + (index % 4) * 240, y = 126 + Math.floor(index / 4) * 202
  cards.push(`<g transform="translate(${x} ${y})"><rect width="224" height="186" rx="18" fill="#171D26" stroke="#2B3340"/><svg x="72" y="24" width="80" height="80" viewBox="${viewBox}" fill="none">${contents}</svg><text x="112" y="129" text-anchor="middle" fill="#EDF1F7" font-size="17" font-weight="600">${escape(identity.label)}</text><text x="112" y="158" text-anchor="middle" fill="${identity.accent}" font-family="monospace" font-size="13">${escape(id)}</text></g>`)
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="24" fill="#0C1119"/><g font-family="Helvetica Neue,Arial,sans-serif"><text x="32" y="53" fill="#F0F4FA" font-size="27" font-weight="600">t-alent / agent identity</text><text x="32" y="87" fill="#8F9AAB" font-size="16">The icon follows your active agent.</text>${cards.join('')}</g></svg>\n`
const destination = new URL('docs/images/agent-icons.svg', root)
await writeFile(destination, svg)
console.log(`Rendered ${ids.length - 1} agent icons and neutral identity: ${fileURLToPath(destination)}`)
