/**
 * dsh-approval-explainer — target extraction.
 *
 * Pulls "where" out of an approval reason so the dialog can say what the AI is
 * about to touch, not just what category of operation it is.
 *
 * WHY THIS IS REGEX, NOT REAL PARSING
 * -----------------------------------
 * There is no tool-argument channel on `ApprovalRequestEvent`: it carries only
 * `agent / toolName / callId / reason / displayReason / signal`, and DSH exposes
 * no public session-read service to look the call up. The reason text is all we
 * get, which is also why DSH puts the command line in it. So this module reads
 * the command out of prose.
 *
 * WHAT IT MUST NEVER DO
 * ---------------------
 * Invent a location. A fabricated precise-looking path is worse than no path: the
 * user would be deciding about the wrong thing with full confidence. When nothing
 * matches, callers fall back to a scope phrase or "范围不明" — see
 * `describeParts()` in `lib/compose.mjs`.
 *
 * Every pattern here is deliberately conservative, and the exclusions matter as
 * much as the matches:
 *   - `-` -prefixed tokens are flags, not paths (`-rf`, `--force`);
 *   - slash-commands are flags (`taskkill /F`, `taskkill /PID 1234`);
 *   - `\bRemove-Item\b` contains an `rm` that a looser pattern would read as a
 *     second command;
 *   - a URL's query string is dropped, because URLs in install commands routinely
 *     carry tokens that must not be echoed into a dialog.
 *
 * Pure and dependency-free, so it is covered by `test/selftest.mjs`.
 */

/** Maximum targets shown; beyond this the list stops being readable. */
export const MAX_TARGETS = 2

// Shell-variable and process-substitution prefixes that get glued onto the front
// of a path (`$HOME/app`, `%TEMP%\x`, `$(pwd)/out`, `${DSH_HOME}/p`).
const VAR_PREFIX =
  '(?:\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\\([^)]*\\))'
const UNC_PREFIX = '(?:\\\\\\\\[^\\\\\\s]+\\\\[^\\s]*)'

/** One path token: Windows drive / UNC / POSIX absolute / variable-prefixed. */
const PATH_RE = new RegExp(
  [
    `[A-Za-z]:[\\\\/][^\\s"'\`|;,)]+`,
    `${UNC_PREFIX}`,
    `${VAR_PREFIX}[\\\\/][^\\s"'\`|;,)]*`,
    `(?<![\\w./-])\\/(?!\\/)[A-Za-z0-9._-][^\\s"'\`|;,)]*`,
  ].join('|'),
  'g',
)

/** Bare file references that are not absolute: `.env`, `lib/index.js`, `a.log`. */
const RELATIVE_FILE_RE =
  /(?<![\w:./-])(?:\.env(?:\.[\w-]+)?|\.[A-Za-z0-9_-]+\/[\w./-]+|(?:[\w-]+\/)*[\w-]+\.(?:env|json|jsonc|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|bat|cmd|md|txt|log|lock|key|pem|crt|sqlite|db|xml|csv|html|css|rs|go|java|rb|php))(?=$|[\s"'\`|;,).\]])/g

/**
 * Operands that a shell would treat as switches rather than data.
 * `/PID 1234` is data once paired with its flag, so the PID is captured apart.
 */
const FLAG_LIKE_RE = /^[/-][A-Za-z]+\d*$/u

/** `taskkill /PID 1234`, `kill -9 1234`, `killall 1234`. */
const PID_RE = /\b(?:taskkill\b[^\n]*?\/PID\s+\d+|\b(?:kill|pkill)\b\s+(?:-[A-Za-z]+\s+)*\d+)/gi

const URL_RE = /https?:\/\/[^\s"'\`|;)]+/gi

const GIT_PUSH_RE = /\bgit\s+push(?:\s+--?[A-Za-z][\w-]*)*\s+([\w.-]+)(?:\s+([\w./-]+))?/i

const DOCKER_RE =
  /\bdocker(?:\s+compose)?\s+(?:run|exec|rm|rmi|stop|start|kill|pull|push|inspect|logs|compose)\s+(?!-)([\w.-]+)/i

/** Strip shell quoting so `".env"` and `.env` compare equal. */
function unquote(token) {
  const trimmed = String(token ?? '').trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** True when a candidate is a shell switch rather than something addressable. */
function isFlagLike(candidate) {
  return FLAG_LIKE_RE.test(candidate)
}

/**
 * Cut a URL down to its origin.
 *
 * The query string is dropped on purpose: install commands regularly carry a
 * token in it, and echoing that into a dialog would leak the secret to anyone
 * looking at the screen. The path is dropped for the same reason the target of a
 * `curl | bash` is really the origin — that is what the user is being asked to
 * trust.
 */
function originOf(url) {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(url)
  return match ? match[1] : url
}

/**
 * Extract every plausible location from a reason / command string.
 *
 * @param {string} text
 * @returns {string[]} deduplicated targets, in first-seen order
 */
export function extractTargets(text) {
  if (typeof text !== 'string' || !text.trim()) return []

  const found = []
  const seen = new Set()
  const push = (value) => {
    const candidate = unquote(value)
    if (!candidate) return
    if (isFlagLike(candidate)) return
    if (seen.has(candidate)) return
    seen.add(candidate)
    found.push(candidate)
  }

  // Pass 1 — URLs. Done first so their path segments can be excluded from the
  // path passes below, where they would otherwise appear as absolute paths.
  const urlSpans = []
  for (const match of text.matchAll(URL_RE)) {
    urlSpans.push([match.index, match.index + match[0].length])
    push(originOf(match[0]))
  }
  const insideUrl = (index) => urlSpans.some(([start, end]) => index >= start && index < end)

  // Pass 2 — absolute paths, then bare file references.
  for (const match of text.matchAll(PATH_RE)) {
    if (insideUrl(match.index)) continue
    push(match[0])
  }

  for (const match of text.matchAll(RELATIVE_FILE_RE)) {
    if (insideUrl(match.index)) continue
    push(match[0])
  }

  // Pass 3 — identifiers that are only meaningful with their flag.
  for (const match of text.matchAll(PID_RE)) {
    const pid = /\/PID\s+(\d+)|\s(\d+)\s*$/i.exec(match[0])
    const value = pid?.[1] ?? pid?.[2]
    if (value && !seen.has(`PID ${value}`)) {
      seen.add(`PID ${value}`)
      found.push(`PID ${value}`)
    }
  }

  // Pass 4 — remote coordinates, which no path pattern can express.
  const remote = GIT_PUSH_RE.exec(text)
  if (remote?.[1] && !remote[1].startsWith('-')) {
    const candidate = remote[2] ? `${remote[1]}/${remote[2]}` : remote[1]
    if (!seen.has(candidate)) {
      seen.add(candidate)
      found.push(candidate)
    }
  }

  const docker = DOCKER_RE.exec(text)
  if (docker?.[1] && !seen.has(docker[1])) {
    seen.add(docker[1])
    found.push(docker[1])
  }

  return found
}

/**
 * Render targets as the text for the "在哪里" row.
 *
 * @param {string[]} targets
 * @returns {string} `''` when there is nothing concrete to report
 */
export function formatTargets(targets) {
  const list = Array.isArray(targets) ? targets.filter(Boolean) : []
  if (!list.length) return ''
  const shown = list.slice(0, MAX_TARGETS)
  const more = list.length > MAX_TARGETS ? ' 等' : ''
  return `${shown.join('、')}${more}`
}
