/**
 * dsh-approval-explainer — host half.
 *
 * Makes an approval dialog readable to someone who does not read English:
 * what the request actually does, how risky it is, and what happens either way.
 * A local rule table answers instantly and offline; a model call, capped by a
 * hard timeout, may add one plain-language sentence.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PLUGIN DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It never decides an approval. The listener always delegates through
 * `next()` and never returns an `ApprovalOutcome`, so it cannot allow, reject,
 * cancel, or auto-approve anything. It only rewrites text the user reads.
 *
 * If you are maintaining this file: keep it that way. A plugin that both
 * explains risk and answers the prompt is a different, much more dangerous
 * thing, and this one must not drift into it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LISTENER IS PREPENDED
 * ---------------------------------------------------------------------------
 * `approval/request` is a waterfall and scope-filtered dispatch. The official
 * web answerer registers at boot, so a listener appended after it would run too
 * late to change what the browser receives. The third argument `true` prepends
 * this listener, which is what puts the Chinese text in front of the client.
 *
 * The durable `approval/asked` audit entry is appended before the waterfall
 * runs, so the session log keeps the original English reason while the user
 * sees the explained text. That is the intended split: presentation changes,
 * the record does not.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MODEL CALL IS TIME-BOXED SO AGGRESSIVELY
 * ---------------------------------------------------------------------------
 * An approval is a blocking interaction: the agent is stopped and the user is
 * staring at the dialog. An auxiliary enrichment call is not worth making them
 * wait. The reference implementation of this idea used a 120s ceiling, which is
 * appropriate for a chat request and unusable here, so `modelTimeoutMs`
 * defaults to 1500ms and every failure path silently falls back to the local
 * rules. The explanation is never allowed to be the reason a dialog is slow.
 */

import { classify } from './rules.mjs'
import { composeExplanation, prepareCandidate } from './compose.mjs'

export const name = 'dsh-approval-explainer'

/**
 * No hard dependency.
 *
 * The approval waterfall comes from this plugin's own context, and everything
 * else — `llm`, `agentDefaultModel` — is resolved optionally through
 * `ctx.get(...)`. An enrichment layer must never be able to stop the plugin from
 * loading: if the model route is missing, the local rules still explain the
 * dialog, which is the whole point.
 */
export const inject = []

const DEFAULTS = {
  enabled: true,
  /** 'auto' keeps the English reason untouched; 'wrap' edits it; 'both' does both. */
  displayMode: 'auto',
  modelLayer: true,
  /** Hard ceiling for the optional model call. 0 disables the model layer. */
  modelTimeoutMs: 1500,
  provider: '',
  model: '',
  maxReasonChars: 800,
  /** How many composed explanations to remember for repeat phrases. */
  cacheSize: 200,
}

const MODEL_SYSTEM_PROMPT = [
  '你是一个把技术操作讲给完全不懂技术的普通用户听的中文助手。',
  '用户现在看到一个英文的软件审批弹窗，不知道该不该点同意。',
  '请根据给出的操作信息，用一到两句话说明：这个操作实际会做什么、最坏情况下会有什么后果。',
  '要求：只用简体中文；不要复述英文；不要使用"可能大概"这类含糊说法；不要建议用户同意或拒绝；只描述事实与后果。',
  '如果信息不足以判断，就直接说"信息不足，无法判断"。',
].join('\n')

/** Small LRU-ish cache: the same phrase should not cost two model calls. */
class ExplanationCache {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 200)
    this.map = new Map()
  }

  get(key) {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)
    // Re-insert to keep the newest entries at the tail.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }
}

function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULTS, ...config }

  if (typeof merged.enabled !== 'boolean') merged.enabled = DEFAULTS.enabled
  if (typeof merged.modelLayer !== 'boolean') merged.modelLayer = DEFAULTS.modelLayer
  if (typeof merged.provider !== 'string') merged.provider = DEFAULTS.provider
  if (typeof merged.model !== 'string') merged.model = DEFAULTS.model

  if (!Number.isFinite(merged.modelTimeoutMs) || merged.modelTimeoutMs < 0) {
    merged.modelTimeoutMs = DEFAULTS.modelTimeoutMs
  }
  if (!Number.isFinite(merged.maxReasonChars) || merged.maxReasonChars <= 0) {
    merged.maxReasonChars = DEFAULTS.maxReasonChars
  }
  if (!Number.isFinite(merged.cacheSize) || merged.cacheSize < 1) {
    merged.cacheSize = DEFAULTS.cacheSize
  }
  if (!['auto', 'wrap', 'both'].includes(merged.displayMode)) {
    merged.displayMode = DEFAULTS.displayMode
  }
  return merged
}

/** Best available English text for a request, preferring the display field. */
function resolveOriginal(req) {
  const display = req?.displayReason
  if (display && typeof display === 'object' && typeof display.en === 'string' && display.en.trim()) {
    return display.en.trim()
  }
  return typeof req?.reason === 'string' ? req.reason.trim() : ''
}

function log(message) {
  console.error(`[${name}] ${message}`)
}

// ---------------------------------------------------------------------------
// Optional model layer
// ---------------------------------------------------------------------------

/**
 * Import the harness's own message constructors.
 *
 * This reaches into `@deepseek-ai/dsh-llm` through the profile's flat fallback
 * directory, so the module identity matches the instance the harness loaded.
 * It is a private surface rather than a published API, which is exactly why
 * every call site treats a failure as "no gloss this time" instead of an error
 * worth surfacing to the user.
 */
let llmApiPromise = null

function loadLlmApi() {
  if (!llmApiPromise) {
    llmApiPromise = import('@deepseek-ai/dsh-llm')
      .then((root) => ({
        BlockAssembler: root.BlockAssembler,
        createUserMessage: root.createUserMessage,
        deepFreeze: root.deepFreeze,
      }))
      .catch((error) => {
        llmApiPromise = null
        throw error
      })
  }
  return llmApiPromise
}

/** Resolve the provider/model route, preferring the user's current selection. */
async function resolveRoute(ctx, config) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') return null

  let provider = config.provider || ''
  let model = config.model || ''

  if (!provider || !model) {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection) {
      if (!provider && typeof selection.provider === 'string') provider = selection.provider
      if (!model && typeof selection.model === 'string') model = selection.model
    }
  }

  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch {
    providers = []
  }
  if (!provider || !providers.some((entry) => entry?.id === provider)) {
    provider = providers[0]?.id ?? ''
  }
  if (!provider) return null

  if (!model) {
    try {
      const models = await llm.listModels(provider)
      model = models?.[0]?.id ?? ''
    } catch {
      model = ''
    }
  }
  if (!model) return null

  return { provider, model }
}

/** True when the failure means the surrounding request was cancelled. */
function isAbort(error) {
  return error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''))
}

/**
 * Ask the model for one plain-language sentence, under a hard deadline.
 * Resolves to `null` on any failure — the caller keeps its local explanation.
 */
async function requestPlainGloss(ctx, config, request, getRoute, setRoute, invalidateRoute) {
  if (!config.modelLayer || config.modelTimeoutMs === 0) return null

  // Resolving a route can reach `listModels`, which is provider I/O. Paying that
  // on every approval would put network latency in front of a blocking dialog,
  // so the resolved route is reused until it stops working.
  let route = getRoute()
  if (route === null) {
    route = (await resolveRoute(ctx, config)) ?? false
    if (route) setRoute(route)
  }
  if (!route) return null

  const api = await loadLlmApi()
  const { BlockAssembler, createUserMessage, deepFreeze } = api
  if (typeof BlockAssembler !== 'function' || typeof createUserMessage !== 'function') return null

  const material = [request.reason, request.command].filter(Boolean).join('\n')
  if (!material.trim()) return null

  const messages = [
    createUserMessage({
      content: [
        {
          type: 'text',
          text:
            `工具名：${request.toolName || '未知'}\n` +
            `审批说明（英文）：${material}\n\n` +
            '本地规则给出的风险等级：' +
            `${request.level}\n请说明这个操作实际会做什么、最坏后果是什么。`,
        },
      ],
      source: { kind: 'plugin', plugin: name },
    }),
  ]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs)
  try {
    const options = deepFreeze
      ? deepFreeze({
          provider: route.provider,
          model: route.model,
          messages,
          system: MODEL_SYSTEM_PROMPT,
          maxTokens: 300,
          signal: controller.signal,
        })
      : {
          provider: route.provider,
          model: route.model,
          messages,
          system: MODEL_SYSTEM_PROMPT,
          maxTokens: 300,
          signal: controller.signal,
        }

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)

    const finish = assembler.finish
    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
      // A model or provider failure can mean the route itself is gone.
      invalidateRoute()
      return null
    }

    const text = assembler
      .blocks()
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    return text || null
  } catch (error) {
    // A timeout is not evidence that the route is bad — the model may simply be
    // slow — so the cached route survives it and only real failures drop it.
    if (!isAbort(error)) {
      log(`model layer unavailable, using local rules only: ${error?.message ?? error}`)
      invalidateRoute()
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const cache = new ExplanationCache(config.cacheSize)

  // One lazily resolved model route, reused across approvals. Held per plugin
  // instance so two mounts do not share a stale route.
  //
  // The tri-state matters: `null` means "not resolved yet", `false` means
  // "resolved and there is no usable route", and an object is the route. A plain
  // falsy check would retry a doomed resolution on every single approval.
  let route = null
  const getRoute = () => route
  const setRoute = (next) => {
    route = next
  }
  const invalidateRoute = () => {
    route = null
  }

  if (!config.enabled) {
    log('disabled by config; no approval text will be changed')
    return
  }

  ctx.on(
    'approval/request',
    async (req, next) => {
      try {
        if (req && typeof req === 'object') {
          await enrich(ctx, config, cache, req, { getRoute, setRoute, invalidateRoute })
        }
      } catch (error) {
        // Enrichment is cosmetic. It must never be able to break an approval.
        log(`explanation failed, leaving the dialog untouched: ${error?.message ?? error}`)
      }
      return next()
    },
    true,
  )
}

/**
 * Attach the Chinese explanation to a request, in place.
 *
 * Deliberately tolerant: the request object is owned by the harness, its
 * properties may be read-only, and it may be frozen. Every write is guarded, and
 * a refused write downgrades to a passthrough rather than an exception.
 *
 * @returns {Promise<boolean>} whether the request was modified
 */
async function enrich(ctx, config, cache, req, routeState) {
  const candidate = prepareCandidate(typeof req.reason === 'string' ? req.reason : '')
  // An absent reason is a legitimate approval request: there is simply nothing to
  // explain, and inventing text for it would be worse than showing nothing.
  if (!candidate) return false

  const original = resolveOriginal(req)
  if (!original) return false

  const cacheKey = `${req.toolName ?? ''}\u0000${candidate.analysisText}`
  const cached = cache.get(cacheKey)
  if (cached) return writeExplanation(config, req, cached)

  const result = classify({ toolName: req.toolName, reason: candidate.analysisText })

  // A second pass over a reason we already explained, where the rules find
  // nothing new, must not stack another explanation block on top. On a first
  // pass the analysis text is the harness's own English reason, so this branch
  // cannot swallow a request that still needs explaining.
  if (candidate.alreadyExplained && result.findings.length === 0) return false

  let plainGloss = null
  if (config.modelLayer) {
    try {
      plainGloss = await requestPlainGloss(
        ctx,
        config,
        {
          toolName: req.toolName,
          reason: candidate.analysisText,
          // There is no public session-read surface for a tool call's arguments,
          // and digging for one would trade a verified mechanism for a fragile
          // one. DSH already puts the command line in the reason text, which is
          // what the rules match on, so the argument channel stays unused.
          command: '',
          level: result.level,
        },
        routeState.getRoute,
        routeState.setRoute,
        routeState.invalidateRoute,
      )
    } catch {
      plainGloss = null
    }
  }

  const explanation = composeExplanation({
    result,
    original,
    plainGloss,
    toolName: req.toolName,
    maxOriginalChars: config.maxReasonChars,
  })

  cache.set(cacheKey, explanation)

  return writeExplanation(config, req, explanation)
}

/**
 * Write the composed explanation onto the request.
 *
 * Two destinations, and the difference matters:
 *
 *   `displayReason.zh` — a display-only field. Writing here leaves `reason`
 *   byte-identical, so anything that reads the reason (logs, other plugins,
 *   approval answerers downstream) still sees exactly what the harness said.
 *   This is the preferred path and the default.
 *
 *   `reason` — what the dialog renders for certain. Editing it is the only
 *   mechanism verified to work end to end, so `wrap`/`both` mode exists as the
 *   fallback for a GUI build that does not render the display field. Because
 *   the composed text already carries the English original verbatim under its
 *   own heading, nothing about what the user is agreeing to becomes hidden.
 */
function writeExplanation(config, req, explanation) {
  let wrote = false

  const mode = config.displayMode

  if (mode === 'auto' || mode === 'both') {
    try {
      const current = req.displayReason && typeof req.displayReason === 'object' ? req.displayReason : {}
      const en = typeof current.en === 'string' && current.en.trim() ? current.en : req.reason
      req.displayReason = { ...current, en, zh: explanation }
      wrote = true
    } catch {
      // A frozen or read-only displayReason is a downgrade, not a failure.
    }
  }

  if (mode === 'wrap' || mode === 'both') {
    try {
      req.reason = explanation
      wrote = true
    } catch {
      // Same: fall through and report whether anything landed at all.
    }
  }

  return wrote
}
