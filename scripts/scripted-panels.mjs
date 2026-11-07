/**
 * Scripted answers for ethics and amendment panels, for tests and the devnet.
 * No model is called. Wraps verafyHarness's scripted provider (answers keyed by
 * contract id, then lab) with three additions:
 *
 *   - a `*` lab key answers for every lab that has no entry of its own
 *   - an ethics screening with no script (`ethics/...`) answers allow, labeled
 *     scripted, citing the subject and Article 3
 *   - the fixtures in test/fixtures/panel-answers.json: the Never allowed
 *     contracts and the scripted amendments
 *
 * A panel stage with no script throws, as the scripted provider does, so a
 * test never passes on an answer nobody wrote.
 * @module swarmchain/scripts/scripted-panels
 */
import { readFileSync } from 'node:fs'

export const PANEL_ANSWERS = JSON.parse(readFileSync(new URL('../test/fixtures/panel-answers.json', import.meta.url), 'utf8'))

const ALLOW = { answer: 'allow', confidence: 0.9, reasoning: 'Scripted answer: nothing in the contract matches a Never allowed item or a case-by-case item.', sources: ['c0', 'c1'] }

/**
 * A provider `complete` over a script plus the panel fixtures.
 * @param {Record<string, Record<string, object>>} script - answers by contract id, then lab.
 * @param {Record<string, Record<string, object>>} [extra] - more answers, which win.
 * @returns {(req: {ascId: string, lab: string}) => Promise<string>} the provider's complete.
 */
export function scriptedComplete(script, extra = {}) {
  const all = { ...script, ...PANEL_ANSWERS, ...extra }
  return async (req = {}) => {
    const byLab = all[req.ascId]
    const a = byLab?.[req.lab] ?? byLab?.['*'] ?? (String(req.ascId).startsWith('ethics/') ? ALLOW : null)
    if (!a) throw new Error(`no scripted answer for ${req.ascId} / ${req.lab}`)
    return JSON.stringify(a)
  }
}
