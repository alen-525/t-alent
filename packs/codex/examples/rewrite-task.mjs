/** Explicit user-authored input customization hook for the Codex package. */
export function transformInput(input, { workspace }) {
  return `Work only in ${workspace}. Follow the user's request:\n\n${input}`
}
