/**
 * dsh-approval-explainer — plain-ESM entry for offline execution.
 *
 * This file exists so the plugin's logic can be imported and tested by a plain
 * `node` process, with no bundler and no DSH runtime:
 *
 *     node test/selftest.mjs
 *
 * The `./lib/*.mjs` modules are the real implementation. Every relative import
 * inside them carries its extension on purpose — Node's ESM resolver requires
 * it, and the extensionless form would only have worked after a build step that
 * this plugin deliberately does not need.
 *
 * `./index.js` is imported last and by its real name: it is the plugin entry the
 * DSH loader mounts, and it pulls in the modules above.
 */

export * from './rules.mjs'
export * from './targets.mjs'
export * from './compose.mjs'
export * from './index.js'
