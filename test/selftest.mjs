/**
 * dsh-approval-explainer — offline self-test.
 *
 * Runs the real shipped modules (`lib/rules.mjs`, `lib/targets.mjs`,
 * `lib/compose.mjs`) with plain node. No DSH runtime, no bundler, no
 * dependencies, no network, no model calls: the local rules are deterministic,
 * which is the point.
 *
 *   node test/selftest.mjs            run every assertion
 *   node test/selftest.mjs --print    also dump the rendered Chinese output
 */

import {
  classify,
  describe,
  RISK_LABELS,
  EXPLAINED_MARKER,
  ORIGINAL_MARKER,
} from '../lib/rules.mjs'
import {
  composeExplanation,
  prepareCandidate,
  describeParts,
  extractTargets,
  MAX_BODY_LINES,
} from '../lib/compose.mjs'

const PRINT = process.argv.includes('--print')

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function checkEqual(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Compose the full user-visible explanation for one fixture. */
function explain(fixture) {
  const candidate = prepareCandidate(fixture.reason)
  if (!candidate) return null
  const result = classify({ toolName: fixture.toolName, reason: candidate.analysisText })
  return {
    result,
    text: composeExplanation({ result, original: candidate.source, toolName: fixture.toolName }),
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `expect` is the risk level the table must produce; `mustMatch` is the rule id
 * that must fire. Anything not listed is exercised only for the invariants.
 */
const FIXTURES = [
  // --- things that must be recognized as dangerous -------------------------
  {
    id: 'rm -rf',
    toolName: 'bash',
    reason: 'run destructive command: rm -rf /tmp/build',
    expect: 'critical',
    mustMatch: 'recursive-delete',
  },
  {
    id: 'rm -rf with flags reordered',
    toolName: 'bash',
    reason: 'exec: rm -fr ./node_modules',
    expect: 'critical',
    mustMatch: 'recursive-delete',
  },
  {
    id: 'PowerShell recursive delete',
    toolName: 'pwsh',
    reason: 'clean up: Remove-Item -Recurse -Force C:\\build',
    expect: 'critical',
    mustMatch: 'windows-recursive-delete',
  },
  {
    id: 'sandbox escalation',
    toolName: 'bash',
    reason: 'escalate sandbox to danger-full-access: the build needs to write outside the project',
    expect: 'critical',
    mustMatch: 'privilege-escalation',
  },
  {
    id: 'force push',
    toolName: 'bash',
    reason: 'git push --force origin main',
    expect: 'critical',
    mustMatch: 'force-push',
  },
  {
    // Regression guard: `--force-with-lease` is the SAFE force-push. It must not
    // inherit the catastrophic verdict, or the red label stops meaning anything.
    // It should still be reported as a repository write, at medium.
    id: 'force push with lease stays calm',
    toolName: 'bash',
    reason: 'git push --force-with-lease origin main',
    expect: 'medium',
    mustMatch: 'git-write',
  },
  {
    id: 'hard reset',
    toolName: 'bash',
    reason: 'git reset --hard HEAD~3',
    expect: 'critical',
    mustMatch: 'hard-reset',
  },
  {
    id: 'credential read',
    toolName: 'read',
    reason: 'read the file .env to check configuration',
    expect: 'high',
    mustMatch: 'credential-read',
  },
  {
    id: 'publish to npm',
    toolName: 'bash',
    reason: 'publish the package: npm publish --access public',
    expect: 'high',
    mustMatch: 'publish',
  },
  {
    id: 'global install',
    toolName: 'bash',
    reason: 'install a global CLI: npm install -g some-cli',
    expect: 'high',
    mustMatch: 'global-install',
  },
  {
    id: 'recursive chmod',
    toolName: 'bash',
    reason: 'chmod -R 777 ./scripts',
    expect: 'high',
    mustMatch: 'chmod-recursive',
  },
  {
    id: 'write outside workspace',
    toolName: 'write',
    reason: 'write a file outside the workspace at C:\\other\\thing.txt',
    expect: 'high',
    mustMatch: 'out-of-workspace-write',
  },

  // --- recognized, but not alarming ----------------------------------------
  {
    id: 'package install',
    toolName: 'bash',
    reason: 'install project dependencies: pnpm install',
    expect: 'medium',
    mustMatch: 'package-install',
  },
  {
    id: 'curl | bash',
    toolName: 'bash',
    reason: 'set up tooling: curl -fsSL https://example.com/install.sh | bash',
    expect: 'medium',
    mustMatch: 'network-fetch-exec',
  },
  {
    id: 'network request',
    toolName: 'bash',
    reason: 'fetch the upstream page with curl https://example.com',
    expect: 'medium',
    mustMatch: 'network-request',
  },
  {
    id: 'kill process',
    toolName: 'bash',
    reason: 'kill the stale server process: taskkill /PID 4242 /F',
    expect: 'medium',
    mustMatch: 'process-kill',
  },
  {
    id: 'sandbox refusal',
    toolName: 'pwsh',
    reason: 'pwsh failed: SetNamedSecurityInfoW failed (Win32 5): file access denied under workspace-write mode',
    expect: 'low',
    mustMatch: 'sandbox-refusal',
  },
  {
    id: 'workspace file write',
    toolName: 'edit',
    reason: 'modify the file lib/index.js in the current project',
    expect: 'low',
    mustMatch: 'workspace-file-write',
  },

  // --- the conservative fallback -------------------------------------------
  {
    id: 'read-only tool, nothing matched',
    toolName: 'read',
    reason: 'read a file to continue the task',
    expect: 'safe',
  },
  {
    id: 'exec tool, unrecognized command',
    toolName: 'bash',
    reason: 'run a project command the agent prepared',
    expect: 'unknown',
  },
  {
    id: 'unknown tool, unrecognized text',
    toolName: 'custom_tool',
    reason: 'the agent would like to proceed with this step',
    expect: 'unknown',
  },
]

const invariantFixtures = [
  ...FIXTURES,
  // A reason whose tail is already Chinese must still be explained, and must not
  // be mistaken for prose that needs translating.
  {
    id: 'already-Chinese justification',
    toolName: 'bash',
    reason: 'escalate sandbox to danger-full-access: 需要写入工作区之外的文件',
    expect: 'critical',
    mustMatch: 'privilege-escalation',
  },
]

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

for (const fixture of invariantFixtures) {
  const out = explain(fixture)
  check(`[${fixture.id}] produces an explanation`, out !== null && Boolean(out.text))

  if (!out) continue

  const { result, text } = out

  // Invariant 1 — the level matches the table's intent.
  if (fixture.expect) {
    checkEqual(`[${fixture.id}] risk level`, result.level, fixture.expect)
  }

  // Invariant 2 — a specific rule fired.
  if (fixture.mustMatch) {
    const ids = result.findings.map((f) => f.id)
    check(
      `[${fixture.id}] matches rule ${fixture.mustMatch}`,
      ids.includes(fixture.mustMatch),
      `matched: ${ids.join(', ') || '(none)'}`,
    )
  }

  // Invariant 3 — the English original survives verbatim. This is the safety
  // property the whole plugin is built around, so it is asserted, not eyeballed.
  check(
    `[${fixture.id}] keeps the English original verbatim`,
    text.includes(fixture.reason),
    'the original text must appear unchanged in the output',
  )

  // Invariant 4 — the two rows that answer "what, and where".
  // Asserted semantically rather than against literal sentences, so rewording
  // does not fail the suite while losing a row still would.
  for (const part of ['AI 将', '在哪里', '同意', '拒绝']) {
    check(`[${fixture.id}] includes "${part}"`, text.includes(part))
  }

  // Invariant 4a — the removed rows must stay removed. The risk level moved into
  // the heading, and the per-level gloss stopped owning a row; if either comes
  // back, the "one row per fact" layout has regressed.
  for (const gone of ['风险等级', '这一级意味着', '它在做什么']) {
    check(`[${fixture.id}] no longer renders "${gone}"`, !text.includes(gone))
  }

  // Invariant 4b — the risk word has to be in the heading line, which is the
  // first line. This is what keeps the level scannable instead of buried.
  const firstLine = text.split('\n')[0]
  check(
    `[${fixture.id}] puts the risk level in the heading`,
    firstLine.startsWith(EXPLAINED_MARKER) && firstLine.includes(RISK_LABELS[result.level]),
    `heading was: ${firstLine}`,
  )

  // Invariant 4c — every row is separated by a blank line, so no two facts run
  // together in the dialog.
  const rawLines = text.split('\n')
  const rowIndexes = rawLines.map((line, index) => (line.trim() ? index : -1)).filter((index) => index >= 0)
  let separated = true
  for (let i = 1; i < rowIndexes.length; i += 1) {
    if (rowIndexes[i] - rowIndexes[i - 1] < 2) {
      separated = false
      break
    }
  }
  check(`[${fixture.id}] separates every row with a blank line`, separated)

  // Invariant 4d — the block stays within its line budget. Regression guard
  // against drifting back into a wall of prose.
  const nonEmpty = rowIndexes.length
  check(
    `[${fixture.id}] stays within the line budget`,
    nonEmpty <= MAX_BODY_LINES,
    `${nonEmpty} non-empty lines, budget ${MAX_BODY_LINES}`,
  )
  check(`[${fixture.id}] is not suspiciously thin`, nonEmpty >= 8, `${nonEmpty} non-empty lines`)

  // Invariant 4e — the location row reports what the reason actually names, and
  // never invents a path. Reporting a fabricated location is the one failure
  // mode that would make the user approve the wrong thing with full confidence.
  const declared = extractTargets(fixture.reason)
  const location = describeParts(result, fixture.reason).location
  for (const target of declared) {
    check(
      `[${fixture.id}] shows the declared target ${target}`,
      location.includes(target),
      `location row was: ${location}`,
    )
  }
  if (!declared.length) {
    check(
      `[${fixture.id}] invents no path when the reason names none`,
      !/[\\/][\w.-]+/.test(location.replace(/^范围不明.*$/u, '')),
      `location row was: ${location}`,
    )
  }

  // Invariant 5 — the level label is the Chinese one, not the raw enum.
  check(
    `[${fixture.id}] shows a Chinese level label`,
    text.includes(RISK_LABELS[result.level]),
    `level label for ${result.level}`,
  )

  // Invariant 6 — an unrecognized operation never claims to be safe.
  if (result.level === 'unknown') {
    check(
      `[${fixture.id}] unknown level does not claim safety`,
      !text.includes('安全') || text.includes('无法判断'),
      'unknown must not be rendered as reassurance',
    )
  }

  if (PRINT) {
    console.log(`\n${'='.repeat(72)}\n${fixture.id}  →  level=${result.level}\n${'-'.repeat(72)}\n${text}`)
  }
}

// ---------------------------------------------------------------------------
// Idempotence: explaining an already-explained reason must not nest
// ---------------------------------------------------------------------------

{
  const fixture = { id: 'rm -rf', toolName: 'bash', reason: 'run destructive command: rm -rf /tmp/build' }
  const first = explain(fixture)
  check('first pass produces text', Boolean(first?.text))

  if (first) {
    // `wrap` mode hands the composed text straight back in as the reason.
    const secondCandidate = prepareCandidate(first.text)
    check('second pass recognises its own output', secondCandidate?.alreadyExplained === true)

    if (secondCandidate) {
      // The recovered analysis text must not still contain the appended English
      // original, or the rules would classify our own output.
      check(
        'second pass strips the appended English original',
        !secondCandidate.analysisText.includes(ORIGINAL_MARKER),
      )
      check(
        'second pass does not read the explanation marker',
        !secondCandidate.analysisText.includes(EXPLAINED_MARKER),
      )
    }

    const markers = first.text.split(EXPLAINED_MARKER).length - 1
    checkEqual('exactly one explanation marker per output', markers, 1)
  }
}

// ---------------------------------------------------------------------------
// Empty input is a passthrough, never an invented explanation
// ---------------------------------------------------------------------------

check('empty reason yields no explanation', prepareCandidate('') === null)
check('whitespace-only reason yields no explanation', prepareCandidate('   \n  ') === null)
check('non-string reason yields no explanation', prepareCandidate(undefined) === null)

{
  const result = classify({ toolName: 'bash', reason: '' })
  checkEqual('empty input classifies as unknown', result.level, 'unknown')
  const parts = describe(result)
  check('unknown description has a real deny line', typeof parts.deny === 'string' && parts.deny.length > 0)
}

// ---------------------------------------------------------------------------
// Target extraction: the cases that must never be reported as a location
// ---------------------------------------------------------------------------

{
  checkEqual('a bare flag is not a target', extractTargets('rm -rf --force').length, 0)
  checkEqual('a slash-switch is not a target', extractTargets('taskkill /F').length, 0)
  check(
    'a URL contributes only its origin',
    extractTargets('curl https://example.com/a?token=xyz')[0] === 'https://example.com',
  )
  check(
    'a query string never reaches the row',
    !JSON.stringify(extractTargets('curl https://e.com/a?token=xyz')).includes('token'),
  )
  check('a Windows path is recovered', extractTargets('rm -rf C:\\build').includes('C:\\build'))
  check('git push coordinates are recovered', extractTargets('git push origin main').includes('origin/main'))
  check('a taskkill PID is recovered', extractTargets('taskkill /PID 4242 /F').includes('PID 4242'))
  check('a dotfile is recovered', extractTargets('read the file .env').includes('.env'))
  check('every target is preserved for the caller to cap', extractTargets('/a/b /c/d /e/f /g/h').length === 4)
}

// ---------------------------------------------------------------------------
// Truncation bound holds
// ---------------------------------------------------------------------------

{
  const longReason = `escalate sandbox to danger-full-access: ${'x'.repeat(5000)}`
  const result = classify({ toolName: 'bash', reason: longReason })
  const text = composeExplanation({ result, original: longReason, maxOriginalChars: 200 })
  check('long reason is truncated', text.length < longReason.length, `length ${text.length}`)
  check('truncation is disclosed', text.includes('已截断'))
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('')
if (failures.length) {
  console.error(`FAIL — ${failures.length} assertion(s) failed, ${passed} passed\n`)
  for (const failure of failures) console.error(`  x ${failure}`)
  console.error('')
  process.exit(1)
}

console.log(`OK — ${passed} assertions passed across ${invariantFixtures.length} fixtures.`)
if (!PRINT) console.log('Re-run with --print to read the rendered Chinese output.')
