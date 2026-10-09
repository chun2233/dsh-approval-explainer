/**
 * dsh-approval-explainer — install sanity check.
 *
 * Run this AFTER mounting the plugin, from the profile directory, so it verifies
 * the one thing that actually breaks local-path installs: whether the loader can
 * resolve the package `name` used in `cordis.patch.yml`.
 *
 *   cd ~/.dsh/profiles/desktop
 *   node "<本目录>/test/verify-install.mjs"
 *
 * It prints a PASS/FAIL report. It does not touch DSH, does not call a model, and
 * does not read your credentials.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = 'dsh-approval-explainer'

let failures = 0
function report(ok, label, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

console.log(`\nprofile cwd : ${process.cwd()}`)
console.log(`checking    : ${PKG}\n`)

// 1 — is the package present where this profile resolves bare specifiers from?
//
// Checked by path rather than `require.resolve`, which throws ERR_REQUIRE_ESM on
// an ESM-only package in some Node versions. Presence on disk is what the loader
// needs; that the entry actually imports is checked in step 2.
const pkgDir = join(process.cwd(), 'node_modules', PKG)
const manifest = join(pkgDir, 'package.json')

let entry
if (!existsSync(pkgDir)) {
  report(
    false,
    `${PKG} is present in ./node_modules`,
    'Install it into this profile, e.g.:\n' +
      `        pnpm add "file:<absolute path to ${PKG}>"\n` +
      `        # or copy the directory into ${join(process.cwd(), 'node_modules')}`,
  )
} else {
  report(true, `${PKG} is present in ./node_modules`, pkgDir)

  // Prefer the declared entry point so this also catches a broken manifest.
  let declaredMain = 'lib/index.js'
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    declaredMain = pkg?.main ?? pkg?.exports?.['.'] ?? declaredMain
    if (typeof declaredMain === 'object') declaredMain = declaredMain?.default ?? 'lib/index.js'
    report(true, 'package.json is readable', `main = ${JSON.stringify(declaredMain)}`)
  } catch (error) {
    report(false, 'package.json is readable', `${error?.message ?? error}`)
  }
  entry = join(pkgDir, typeof declaredMain === 'string' ? declaredMain : 'lib/index.js')
}

// 2 — does it expose the shape the loader needs?
if (entry) {
  try {
    const mod = await import(pathToFileURL(entry).href)
    report(mod.name === PKG, 'exports the plugin name', `name = ${JSON.stringify(mod.name)}`)
    report(typeof mod.apply === 'function', 'exports apply(ctx, config)')
    report(Array.isArray(mod.inject), 'exports an inject list', `inject = ${JSON.stringify(mod.inject)}`)
  } catch (error) {
    report(false, 'the entry module imports cleanly', `${error?.message ?? error}`)
  }

  // 3 — do the rules load, and does the conservative fallback hold?
  try {
    const rules = await import(new URL('../lib/rules.mjs', import.meta.url).href)
    const unknown = rules.classify({ toolName: 'custom_tool', reason: 'proceed with the next step' })
    report(unknown.level === 'unknown', 'unrecognized input falls back to unknown', `got ${unknown.level}`)

    const dangerous = rules.classify({ toolName: 'bash', reason: 'rm -rf /tmp/x' })
    report(dangerous.level === 'critical', 'rm -rf is classified critical', `got ${dangerous.level}`)
  } catch (error) {
    report(false, 'the rules module loads', `${error?.message ?? error}`)
  }
}

console.log('')
if (failures) {
  console.log(`RESULT: ${failures} check(s) failed — see README "安装" for the fallbacks.\n`)
  process.exit(1)
}
console.log('RESULT: all checks passed. Trigger an approval to see the explanation.\n')
