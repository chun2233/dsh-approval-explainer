/**
 * dsh-approval-explainer — explanation composition.
 *
 * Turns a classification into the exact Chinese text shown in the approval
 * dialog. Pure and dependency-free, so it can be golden-tested offline.
 *
 * THE ONE HARD RULE
 * -----------------
 * Whatever else this module does, the text under `【英文原文】` is the caller's
 * input, verbatim. Asking someone to approve something they cannot read is a
 * safety defect, not a feature: the explanation is additive, never substitutive.
 *
 * LAYOUT — one row per fact, separated by blank lines
 * ---------------------------------------------------
 *     **【这条审批是什么意思】危险 · 递归强制删除文件**
 *
 *     **AI 将**　删除整个目录及其全部内容，不再询问确认。
 *     **在哪里**　/tmp/build
 *
 *     **同意**　这些文件和目录会立刻消失，不进回收站，无法撤销或恢复。
 *     **拒绝**　文件原封不动，删除不会发生。
 *
 *     【英文原文】
 *     run destructive command: rm -rf /tmp/build
 *
 * The risk word rides in the heading rather than owning a row, because a reader
 * deciding whether to click needs the grade before the prose — not three lines
 * into it. The two opening rows answer "what is the AI about to do, and where",
 * which is the question a beginner cannot answer for themselves from a command
 * line.
 *
 * Modules in this directory use the `.mjs` extension and explicit import
 * extensions so a plain `node` process can load them directly — no build step,
 * which is what lets `test/selftest.mjs` test the shipped code rather than a
 * copy of it.
 */

import {
  describe,
  glossFor,
  RISK_LABELS,
  EXPLAINED_MARKER,
  ORIGINAL_MARKER,
  stripOriginalSection,
} from './rules.mjs'
import { extractTargets, formatTargets } from './targets.mjs'

export {
  EXPLAINED_MARKER,
  ORIGINAL_MARKER,
  isAlreadyExplained,
  hasOriginalSection,
  stripOriginalSection,
} from './rules.mjs'

const DEFAULT_MAX_ORIGINAL_CHARS = 800

/**
 * Line budget for the composed block, counting the English-original section.
 *
 * The approval dialog is read while the agent is stopped, so the explanation has
 * to stay scannable rather than exhaustive. When optional parts would push the
 * block past this, they are dropped in priority order; the action, location,
 * decision rows and the English original are never candidates.
 */
export const MAX_BODY_LINES = 12

/** Full-width space used to separate a bold label from its text. */
const GAP = '\u3000'

/** Severity ordering, mirrored from `rules.mjs` to rank the finding labels. */
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, safe: 4, unknown: 5 }

/** Shorten text to `max` characters, marking that truncation happened. */
export function truncate(text, max) {
  if (typeof text !== 'string') return ''
  if (!Number.isFinite(max) || max <= 0) return text
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（已截断，完整内容见会话记录）`
}

/**
 * Split a reason into its machine prefix and its prose body.
 *
 * DSH reasons are frequently shaped like
 *   `escalate sandbox to danger-full-access: <model-authored justification>`
 * Keeping the prefix visible lets a reader match the dialog against the English
 * original, while the body is what the rules are really about.
 *
 * Splitting only at a colon followed by whitespace keeps Windows drive letters
 * (`C:\...`) and URL schemes from being mistaken for a prefix.
 */
export function splitReason(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const match = /^([^\n:]{1,80}?):\s+([\s\S]+)$/.exec(trimmed)
  if (match) return { head: match[1], body: match[2].trim() }
  return { head: '', body: trimmed }
}

/**
 * Build the heading line, with the risk word pulled forward.
 *
 * The level used to own a row of its own, which buried the single most important
 * token in the block. Putting it in the heading right after the marker makes it
 * the first thing read, and the rule label hands a beginner the gist before any
 * prose.
 */
export function composeTitle(result, shortLabel) {
  const level = typeof result?.level === 'string' ? result.level : 'unknown'
  const label = RISK_LABELS[level] ?? RISK_LABELS.unknown
  return shortLabel ? `${EXPLAINED_MARKER}${label} · ${shortLabel}` : `${EXPLAINED_MARKER}${label}`
}

/** The most severe finding of a classification, or `null` when none fired. */
function worstFinding(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : []
  if (!findings.length) return null
  return findings.reduce((acc, f) => (SEVERITY_ORDER[f.level] < SEVERITY_ORDER[acc.level] ? f : acc), findings[0])
}

/**
 * Resolve the "在哪里" row.
 *
 * A concrete target wins, but only when it came from a rule that fires on real
 * command text. A `safe` or `unknown` classification names no location, and
 * guessing one would be worse than admitting we do not know — the user would be
 * deciding about the wrong thing with full confidence. Hence: findings only.
 */
function resolveLocation(result, parts, probe) {
  const findings = Array.isArray(result?.findings) ? result.findings : []
  if (findings.length) {
    const targets = formatTargets(extractTargets(probe))
    if (targets) return targets
  }
  return parts.scope || '范围不明，详见下方英文原句'
}

/**
 * Assemble the composable pieces of one explanation.
 *
 * Exported for the self-test, which asserts the row structure without having to
 * re-parse the rendered text.
 *
 * @param {object} result  classification from `classify()`
 * @param {string} original reason text, used as the target probe
 * @returns {{title:string, action:string, location:string, rows:Array<{label:string,text:string}>,
 *            allow:string, deny:string, extra:string[]}}
 */
export function describeParts(result, original) {
  const parts = describe(result)
  const worst = worstFinding(result)
  const location = resolveLocation(result, parts, original)
  return {
    title: composeTitle(result, worst?.label),
    action: parts.what,
    location,
    rows: [
      { label: 'AI 将', text: parts.what },
      { label: '在哪里', text: location },
    ],
    allow: parts.allow,
    deny: parts.deny,
    extra: Array.isArray(parts.extra) ? parts.extra : [],
  }
}

/** Render `label` and `text` as one row, or a single row when text is empty. */
function row(label, text) {
  if (!text) return []
  return [`**${label}**${GAP}${text}`]
}

/**
 * Compose the Chinese explanation block.
 *
 * @param {object} options
 * @param {object} options.result            classification from `classify()`
 * @param {string} options.original          the reason text being explained
 * @param {string} [options.plainGloss]      optional model-written one-liner
 * @param {string} [options.toolName]        DSH tool name, for orientation
 * @param {number} [options.maxOriginalChars]
 * @param {number} [options.maxLines]        line budget, defaults to MAX_BODY_LINES
 * @returns {string}
 */
export function composeExplanation(options = {}) {
  const original = typeof options.original === 'string' ? options.original : ''
  const result = options.result ?? { level: 'unknown', findings: [], note: null }
  const budget = Number.isFinite(options.maxLines) && options.maxLines > 0 ? options.maxLines : MAX_BODY_LINES

  const parts = describeParts(result, original)
  const { head } = splitReason(original)

  // Each block is its own paragraph, with one blank line between them, so no two
  // facts run together in the dialog.
  const blocks = [
    [`**${parts.title}**`],
    [...row('AI 将', parts.action), ...row('在哪里', parts.location)],
    [...row('同意', parts.allow), ...row('拒绝', parts.deny)],
  ]

  // Optional blocks, in the order they may be sacrificed: the model gloss is
  // long, the reason prefix repeats the English original, and the tool
  // attribution is the least load-bearing of the three.
  if (typeof options.plainGloss === 'string' && options.plainGloss.trim()) {
    blocks.push([`**通俗一点说**${GAP}${options.plainGloss.trim()}`])
  }
  for (const extra of parts.extra) blocks.push([`· ${extra}`])
  if (head) blocks.push([`审批类型：${head}`])
  if (typeof options.toolName === 'string' && options.toolName) {
    blocks.push([`（本次审批来自工具：${options.toolName}）`])
  }

  const originalBlock = [
    ORIGINAL_MARKER,
    truncate(original, options.maxOriginalChars ?? DEFAULT_MAX_ORIGINAL_CHARS),
  ]

  const render = (list) => [...list.flatMap((block) => [...block, '']), ...originalBlock].join('\n')
  const countRows = (list) => list.flat().filter((line) => line.trim()).length + originalBlock.length

  // Trim optional blocks from the tail until the block fits the budget.
  while (countRows(blocks) > budget && blocks.length > 3) {
    blocks.pop()
  }

  return render(blocks)
}

/**
 * Decide what should be classified for one request, and whether a previous pass
 * already explained it.
 *
 * Returns `null` when there is nothing to explain (no reason text), which is the
 * signal for the caller to fall straight through to `next()`.
 *
 * A second pass sees a reason carrying our own explanation block plus, in `wrap`
 * mode, the appended English original. Feeding that back to the rules would
 * classify our own output: the explanation block is Chinese so the rules cannot
 * fire on it, but the appended English original would. Hence the
 * `stripOriginalSection` recovery.
 *
 * @param {string} rawReason
 * @returns {{source:string, analysisText:string, alreadyExplained:boolean}|null}
 */
export function prepareCandidate(rawReason) {
  const source = typeof rawReason === 'string' ? rawReason : ''
  if (!source.trim()) return null

  const alreadyExplained = source.includes(EXPLAINED_MARKER)
  const analysisText = (alreadyExplained ? stripOriginalSection(source) : source).trim()
  if (!analysisText) return null

  return { source, analysisText, alreadyExplained }
}

/** Re-exported so the self-test can exercise target extraction directly. */
export { extractTargets, formatTargets } from './targets.mjs'

/** Exposed for documentation and diagnostics. */
export { glossFor }
