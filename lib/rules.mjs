/**
 * dsh-approval-explainer — local risk rules.
 *
 * PURE and DEPENDENCY-FREE: imports nothing, touches no DSH API, and can be
 * exercised with plain `node` (see `test/selftest.mjs`). DSH wiring lives in
 * `lib/index.js`.
 *
 * DESIGN RULE — CONSERVATIVE BY CONSTRUCTION
 * ------------------------------------------
 * An unrecognized operation never gets a reassuring verdict. When nothing
 * matches we return `unknown`, rendered as "无法判断，请自己看一眼原句" rather than
 * "安全". Labeling a dangerous command as safe is the one failure mode of this
 * plugin that can actually hurt the user, so the table prefers silence over
 * optimism.
 *
 * This is pattern matching, NOT a security review. It will miss things. That is
 * exactly why the fallback is `unknown` and not `safe`.
 */

/** Severity ladder, ordered from most to least severe. */
export const RISK_LEVELS = ['critical', 'high', 'medium', 'low', 'safe', 'unknown']

/** Injection-ordered severity, used to pick the most severe finding of many. */
const SEVERITY = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  safe: 4,
  unknown: 5,
}

/** Chinese label shown to the user for each level. */
export const RISK_LABELS = {
  critical: '危险',
  high: '高',
  medium: '中',
  low: '低',
  safe: '只读',
  unknown: '无法判断',
}

/**
 * Short gloss for each level.
 *
 * Deliberately one clause, not a sentence: a dialog the user reads while the
 * agent is stopped cannot spend a wrapped line on information the level label
 * already implies. The irreversible / out-of-bounds / credential distinctions
 * still survive the shortening — they are what the user is deciding about.
 */
export const RISK_GLOSS = {
  critical: '可能造成不可逆的破坏或数据丢失。',
  high: '会影响工作区以外的系统，或触及敏感凭据。',
  medium: '会写入、联网或安装，值得看清具体对象。',
  low: '影响局限在当前工作区内，通常可回退。',
  safe: '只读取，不改动任何东西。',
  unknown: '没识别出操作类型，请自己看一眼英文原句。',
}

/**
 * Markers identifying text this plugin already produced. They are matched
 * against the raw reason so a second pass (or a second loaded copy) never wraps
 * a wrapped reason again.
 */
export const EXPLAINED_MARKER = '【这条审批是什么意思】'
export const ORIGINAL_MARKER = '【英文原文】'

/** True when `text` already carries this plugin's explanation block. */
export function isAlreadyExplained(text) {
  return typeof text === 'string' && text.includes(EXPLAINED_MARKER)
}

/** True when `text` carries the appended English-original section. */
export function hasOriginalSection(text) {
  return typeof text === 'string' && text.includes(ORIGINAL_MARKER)
}

/**
 * Cut our own appended original section back off. Without this, re-classifying a
 * wrapped reason would feed the English original back through the rules as if it
 * were new text.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripOriginalSection(text) {
  if (typeof text !== 'string') return ''
  if (!hasOriginalSection(text)) return text
  return text.slice(0, text.indexOf(ORIGINAL_MARKER)).trimEnd()
}

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------

const CJK_RE = /[\u3400-\u9fff\uF900-\uFAFF]/
const KANA_RE = /[\u3040-\u30ff]/
const HANGUL_RE = /[\uac00-\ud7af]/
const CYRILLIC_RE = /[\u0400-\u04ff]/

/** True when the text contains Simplified Chinese. */
export function looksChinese(text) {
  if (!text || typeof text !== 'string') return false
  return CJK_RE.test(text)
}

/**
 * True when the text carries prose worth explaining: a run of four Latin
 * letters. Guards against treating `rm -rf` or a bare path as a sentence.
 */
export function hasTranslatableProse(text) {
  if (!text || typeof text !== 'string') return false
  return /[A-Za-z]{4,}/.test(text)
}

/** True when the text is Latin-script prose, i.e. worth explaining in Chinese. */
export function isForeignProse(text) {
  if (!text || typeof text !== 'string') return false
  if (CJK_RE.test(text) || KANA_RE.test(text) || HANGUL_RE.test(text) || CYRILLIC_RE.test(text)) {
    return false
  }
  return hasTranslatableProse(text)
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Read-only DSH tools. By the time one of these asks for approval the request is
 * usually about *where* it may look, not about destruction.
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'lsp',
  'read_image',
  'job_list',
  'job_output',
  'list_agents',
  'team_task_list',
  'team_task_get',
  'session_search',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_trace',
  'get_goal',
  'cordis_inspect_list',
  'cordis_inspect_query',
])

/** Tools whose approval is fundamentally about running a program. */
const EXEC_TOOLS = new Set(['bash', 'pwsh', 'shell', 'run_command', 'terminal_open'])

/**
 * The ordered rule table. See README for the full severity breakdown.
 *
 * Each rule: `id` (stable, also the fixture key), `level`, `label`, `what`,
 * `allow`, `deny`, and `re` tested against the composed body text.
 *
 * `allow` / `deny` are written for a reader with no command-line background: say
 * what changes on disk, what leaves the machine, what cannot be undone.
 */
export const RULES = [
  // ---------------------------------------------------------------- critical
  {
    id: 'recursive-delete',
    level: 'critical',
    label: '递归强制删除文件',
    // `[a-z]*` plus explicit `(?![A-Za-z])` boundaries rather than a nested
    // case-insensitive group: the flags can appear in either order, and
    // `\bRemove-Item\b` must not be read as an `rm` invocation.
    re: /\brm(?![A-Za-z])\s+-[a-z]*r[a-z]*f[a-z]*(?![A-Za-z])|\brm(?![A-Za-z])\s+-[a-z]*f[a-z]*r[a-z]*(?![A-Za-z])|\brm(?![A-Za-z])\s+--recursive\s+--force|\brm(?![A-Za-z])\s+--force\s+--recursive|\brm(?![A-Za-z])\s+-[a-z]*r[a-z]*\s+\//,
    what: '删除整个目录及其全部内容，不再询问确认。',
    allow: '这些文件和目录会立刻消失，不进回收站，无法撤销或恢复。',
    deny: '文件原封不动，删除不会发生。',
  },
  {
    id: 'windows-recursive-delete',
    level: 'critical',
    label: 'Windows 递归强制删除',
    // Two alternatives rather than a lookahead: matching the two switches in
    // either order is a plain string test, and a lookahead here would be the
    // easiest thing in the table to fat-finger.
    re: /\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force|\bRemove-Item\b[^\n]*-Force[^\n]*-Recurse|\bdel\s+\/[fsq]|\brd\s+\/s|\brmdir\s+\/s/i,
    what: '在 Windows 上递归强制删除目录或文件。',
    allow: '目标内容被直接删除，不走回收站，无法恢复。',
    deny: '不会有任何文件被删除。',
  },
  {
    id: 'disk-format',
    level: 'critical',
    label: '磁盘格式化 / 分区操作',
    re: /\b(?:format\s+[A-Za-z]:|mkfs(?:\.\w+)?\b|diskpart\b|diskutil\s+erase\w*|dd\s+[^\n]*of=\/dev\/|newfs\b)/i,
    what: '对磁盘或分区做格式化、擦除或底层写入。',
    allow: '该磁盘上的全部数据被清除，这是不可逆的。',
    deny: '磁盘保持原样。',
  },
  {
    id: 'force-push',
    level: 'critical',
    label: '强制覆盖远程 Git 历史',
    // `--force-with-lease` is deliberately NOT matched: it refuses to overwrite a
    // remote that moved since your last fetch, so it is the safe way to do this
    // and is excluded by the lookahead. Flagging it as catastrophic would teach
    // the user to ignore the red label.
    re: /git\s+push\b[^\n]*(?:--force(?!-with-lease)|-f\b)/i,
    what: '用本地提交强制覆盖远程仓库的历史。',
    allow: '远程分支被改写，队友已拉取的提交会和远程分叉，他们的工作可能被覆盖。',
    deny: '远程仓库保持原样，历史不变。',
  },
  {
    id: 'hard-reset',
    level: 'critical',
    label: '丢弃未提交的改动',
    re: /git\s+reset\s+--hard\b|git\s+checkout\s+--\s+\.|git\s+restore\s+[^\n]*--worktree[^\n]*--staged/i,
    what: '把工作区回退到某次提交，丢弃未提交的修改。',
    allow: '尚未提交的代码改动永久丢失。',
    deny: '改动保留在原处。',
  },
  {
    id: 'privilege-escalation',
    level: 'critical',
    label: '权限升级',
    re: /danger[-_ ]?full[-_ ]?access|escalat\w*[^\n]{0,40}sandbox|sandbox[^\n]{0,40}escalat|raise[^\n]{0,20}(?:permission|access)|提权|权限升级|越权/i,
    what: '把操作权限从"仅限当前工作区"提到"可访问整台电脑"。',
    allow: '这次操作不再受工作区限制，可读写任意文件、执行任意程序。',
    deny: '权限不变，操作要么在工作区内完成，要么直接失败。这是最安全的默认值。',
  },
  {
    id: 'system-directory-write',
    level: 'critical',
    label: '修改系统目录',
    re: /[A-Za-z]:\\Windows\b|\/etc\/(?:passwd|shadow|sudoers)\b|\/System\/|\/usr\/(?:lib|bin)\/|\breg\s+(?:add|delete|import)\b/i,
    what: '向系统目录或注册表写入内容。',
    allow: '系统文件被改动，可能影响整台电脑的稳定，甚至无法正常启动。',
    deny: '系统文件保持不变。',
  },

  // -------------------------------------------------------------------- high
  {
    id: 'credential-read',
    level: 'high',
    label: '读取凭据 / 密钥',
    re: /\.env\b|\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.pypirc|\.git-credentials|credentials\.json|secrets?\.(?:ya?ml|json)|(?:API[_ -]?KEY|SECRET[_ -]?KEY|ACCESS[_ -]?TOKEN|PRIVATE[_ -]?KEY)/i,
    what: '读取保存密码、密钥或访问令牌的文件。',
    allow: '密钥内容会进入对话记录；如果之后被发到模型服务或粘贴到别处，等于泄露。',
    deny: '密钥文件不会被读取。可以让它改用环境变量，或由系统自己读凭据。',
  },
  {
    id: 'git-clean',
    level: 'high',
    label: '清理未跟踪文件',
    re: /git\s+clean\b[^\n]*-[a-z]*[fdx]/i,
    what: '删除所有未被 Git 跟踪的文件（通常包括你没提交过的新文件）。',
    allow: '这些文件被永久删除。',
    deny: '未跟踪的文件保留。',
  },
  {
    id: 'chmod-recursive',
    level: 'high',
    label: '递归改权限',
    re: /\b(?:chmod\s+[^\n]*-R\b|chmod\s+[0-7]{3,4}\s+-R\b|icacls\b[^\n]*\/grant|takeown\s+\/f)/i,
    what: '递归修改目录下所有文件的访问权限。',
    allow: '整个目录树的权限被改写，其他程序或用户可能都能读写甚至执行这些文件。',
    deny: '权限保持不变。',
  },
  {
    id: 'publish',
    level: 'high',
    label: '发布到公共仓库',
    re: /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgh\s+release\s+create\b/i,
    what: '把当前项目发布到公共仓库，任何人都能下载。',
    allow: '代码和版本号对外公开；即使之后删除，也可能已被别人下载或镜像。',
    deny: '不会发布，项目仍然只在本地。',
  },
  {
    id: 'global-install',
    level: 'high',
    label: '全局安装软件',
    re: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b[^\n]*(?:-g\b|--global)|\bpip3?\s+install\b[^\n]*--user\b|\bnpm\s+link\b/i,
    what: '把软件装到系统全局位置，而不是当前项目里。',
    allow: '命令行环境被永久改动，影响这台电脑上的所有项目。',
    deny: '系统环境保持不变。',
  },
  {
    id: 'out-of-workspace-write',
    level: 'high',
    label: '写入工作区之外',
    re: /outside\s+(?:the\s+)?workspace|outside\s+of\s+(?:the\s+)?workspace|beyond\s+(?:the\s+)?workspace|工作区之外|工作区以外/i,
    what: '把文件写到当前项目目录之外的位置。',
    allow: '会改动项目范围以外的文件，可能影响其他项目或系统配置。',
    deny: '只允许在当前项目目录内操作。',
  },

  // ------------------------------------------------------------------ medium
  {
    id: 'package-install',
    level: 'medium',
    label: '安装依赖包',
    re: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b/i,
    what: '从网络下载并安装软件包。',
    allow: '会联网下载代码并装进项目依赖，安装脚本会以你的身份运行。',
    deny: '不会安装任何东西，依赖保持现状。',
  },
  {
    id: 'network-fetch-exec',
    level: 'medium',
    label: '下载并直接执行脚本',
    re: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b|\b(?:curl|wget|iwr)\b[^\n]*\|\s*(?:pwsh|powershell|node|python)/i,
    what: '从网络下载脚本，不给你看内容就直接执行。',
    allow: '远程服务器上的任意代码会以你的身份运行，对方改一次内容行为就变了。',
    deny: '脚本不会执行。可以先只下载、自己看过内容再决定。',
  },
  {
    id: 'network-request',
    level: 'medium',
    label: '访问网络',
    re: /\b(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest|ssh|scp)\b|\bgh\s+(?:api|pr|issue|release)\b|\bdocker\s+pull\b|\bgit\s+(?:clone|fetch|pull|push)\b/i,
    what: '向网络地址发起请求或与远程主机通信。',
    allow: '会向外部发送请求；命令里若带着你的数据或令牌，这些内容会离开这台电脑。',
    deny: '不会产生任何网络访问。',
  },
  {
    id: 'process-kill',
    level: 'medium',
    label: '结束进程 / 服务',
    re: /\b(?:kill|pkill|killall|taskkill|Stop-Process|Stop-Service)\b|\bnet\s+stop\b|\bsc\s+(?:stop|delete)\b/i,
    what: '强制结束正在运行的程序或系统服务。',
    allow: '被指定的进程立即中止，其中未保存的数据会丢失。',
    deny: '进程继续运行。',
  },
  {
    id: 'git-write',
    level: 'medium',
    label: '写入 Git 仓库',
    re: /git\s+(?:commit|add|merge|rebase|cherry-pick|tag|branch\s+-[dD]|stash\s+(?:drop|clear)|push)\b/i,
    what: '改动本地或远程的代码仓库状态。',
    allow: '仓库历史或暂存区被改变；rebase、push 这类操作会改写已有提交。',
    deny: '仓库保持原状。',
  },
  {
    id: 'docker',
    level: 'medium',
    label: '操作 Docker',
    re: /\bdocker\s+(?:run|rm|rmi|stop|kill|compose|exec|system\s+prune|volume\s+rm)\b/i,
    what: '启动、停止或删除 Docker 容器、镜像或数据卷。',
    allow: '容器环境发生变化；system prune 和 volume rm 会删数据且不可恢复。',
    deny: '容器环境保持不变。',
  },

  // -------------------------------------------------------------------- low
  {
    id: 'workspace-file-write',
    level: 'low',
    label: '改工作区内的文件',
    re: /\b(?:write|edit|create|modify|overwrite|append)\b[^\n]{0,40}\b(?:file|files|path|directory)\b|\bSet-Content\b|\bOut-File\b|\bNew-Item\b|\bmkdir\b/i,
    what: '在当前项目目录里创建或修改文件。',
    allow: '项目里的文件被改动，属于正常工作，也是可以回退的。',
    deny: '文件保持不变。',
  },

  // --------------------------------------------------------- sandbox refusals
  {
    id: 'sandbox-refusal',
    level: 'low',
    label: '被权限规则挡住',
    re: /access\s+denied|permission\s+denied|EPERM|EACCES|not\s+permitted|operation\s+not\s+permitted|policy\s+denial|sandbox[^\n]{0,30}denied|denied\s+under\s+[^\n]{0,30}mode|被拒绝|权限不足/i,
    what: '这次尝试被权限规则拦住了，并没有真的执行成功。',
    allow: '如果同意，同样的操作会被放行一次。',
    deny: '操作继续被拦住，这通常就是安全的默认结果。',
  },
]

// ---------------------------------------------------------------------------
// Location scopes
// ---------------------------------------------------------------------------

/**
 * Where a matched rule typically acts, when the reason text names no concrete
 * target.
 *
 * These are deliberately ranges, not paths. There is no tool-argument channel on
 * an approval request, so a specific path can only come from the reason text —
 * and when it is absent, saying "整个目标目录" is honest while inventing
 * `/some/path` would be actively dangerous.
 */
export const SCOPES = {
  'recursive-delete': '整个目标目录',
  'windows-recursive-delete': '整个目标目录',
  'disk-format': '目标磁盘 / 分区',
  'force-push': '远程仓库',
  'hard-reset': '当前工作区',
  'privilege-escalation': '整台电脑（工作区之外）',
  'system-directory-write': '系统目录与注册表',
  'credential-read': '凭据文件所在目录',
  'git-clean': '当前工作区',
  'chmod-recursive': '整个目标目录树',
  publish: '公共软件仓库',
  'global-install': '系统全局环境',
  'out-of-workspace-write': '当前工作区之外',
  'package-install': '当前项目与系统环境',
  'network-fetch-exec': '网络与当前项目',
  'network-request': '网络',
  'process-kill': '本机运行中的进程',
  docker: 'Docker 容器 / 镜像',
  'workspace-file-write': '当前工作区',
  'sandbox-refusal': '先前被拦截的同一位置',
}

/** The scope phrase for a rule id, or an explicit "we do not know". */
export function scopeFor(ruleId) {
  return SCOPES[ruleId] ?? '范围不明，详见下方英文原句'
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function outOfWorkspaceHint(text) {
  const hits = []
  const windowsAbs = text.match(/[A-Za-z]:\\[^\s"',;)\]]+/g)
  if (windowsAbs) hits.push(...windowsAbs)
  const posixAbs = text.match(/(?:^|\s)\/(?:etc|usr|var|opt|root|System)\b[^\s"',;)\]]*/g)
  if (posixAbs) hits.push(...posixAbs.map((s) => s.trim()))
  return [...new Set(hits)].slice(0, 3)
}

/**
 * Compile one rule and test it, without leaking `lastIndex` between calls.
 *
 * The table is written with `/i` for readability, but a handful of patterns need
 * case-insensitive class subtraction (`[^A-Z]`), which only means what it looks
 * like under the `u` flag. Flags are stripped here, the class escapes are mapped
 * to their Unicode-property equivalents, and `u` is applied exactly when needed.
 */
function applyRule(rule, text) {
  const flags = rule.re.flags.replace('g', '')
  const needsUnicodeClasses = rule.re.source.includes('\\p{')
  const source = needsUnicodeClasses
    ? rule.re.source
        .replace(/\[\^A-Z\]/g, '[^\\p{Lu}]')
        .replace(/\[\^a-z\]/g, '[^\\p{Ll}]')
        .replace(/\[\^A-Za-z\]/g, '[^\\p{L}]')
        .replace(/\[\^0-9\]/g, '[^\\p{Nd}]')
    : rule.re.source
  const re = new RegExp(source, needsUnicodeClasses && !flags.includes('u') ? `${flags}u` : flags)
  if (!re.test(text)) return null
  return {
    id: rule.id,
    level: rule.level,
    label: rule.label,
    what: rule.what,
    allow: rule.allow,
    deny: rule.deny,
  }
}

function buildInputs(input) {
  const reason = typeof input?.reason === 'string' ? input.reason : ''
  const command = typeof input?.command === 'string' ? input.command : ''
  const args = typeof input?.argumentsRaw === 'string' ? input.argumentsRaw : ''
  return { reason, command, args, index: [reason, command, args].filter(Boolean).join('\n') }
}

/**
 * Classify one approval request.
 *
 * @param {object} input
 * @param {string} [input.toolName]     DSH tool name.
 * @param {string} [input.reason]       the approval reason text.
 * @param {string} [input.command]      a command string, when the caller has one.
 * @param {string} [input.argumentsRaw] raw tool arguments, when available.
 * @returns {{level:string, findings:Array, hints:string[], note:string|null}}
 */
export function classify(input = {}) {
  const { index } = buildInputs(input)
  const toolName = typeof input.toolName === 'string' ? input.toolName : ''
  const findings = []

  for (const rule of RULES) {
    const hit = applyRule(rule, index)
    if (hit) findings.push(hit)
  }

  const hints = outOfWorkspaceHint(index)

  // Nothing matched. Choose between an honest `unknown` and a defensible `safe`
  // — never invent reassurance.
  if (!findings.length) {
    if (READ_ONLY_TOOLS.has(toolName)) {
      return {
        level: 'safe',
        findings: [],
        hints,
        note: `工具 \`${toolName}\` 只读取信息，不修改任何东西。如果这次审批问的是访问范围，同意的代价很低。`,
      }
    }
    return {
      level: 'unknown',
      findings: [],
      hints,
      note: EXEC_TOOLS.has(toolName)
        ? `这是一次 \`${toolName}\` 命令执行审批，但没有识别出具体命令类型。命令内容会原样显示在下面，请自己确认。`
        : null,
    }
  }

  const worst = findings.reduce((acc, f) => (SEVERITY[f.level] < SEVERITY[acc.level] ? f : acc), findings[0])

  // A read-only tool with only a low-severity finding is effectively "reading
  // from somewhere new": keep it honest, but not alarming.
  let level = worst.level
  if (level === 'low' && READ_ONLY_TOOLS.has(toolName)) level = 'safe'

  let note = null
  if (findings.length > 1) {
    const others = findings.filter((f) => f.id !== worst.id).map((f) => f.label)
    note = `这次审批同时涉及：${others.join('、')}。风险等级按最严重的一项给出。`
  }

  return { level, findings, hints, note }
}

/**
 * Build the plain-language explanation for a classification.
 * Shared by the composer and the self-test so both stay in lockstep.
 *
 * `title` is the Chinese **level** label (`危险` / `高` / …) — note that the
 * per-rule label a reader actually sees comes from the matched finding, which the
 * composer reads directly.
 *
 * @returns {{title:string, what:string, scope:string, allow:string, deny:string, extra:string[]}}
 */
export function describe(result) {
  const level = result?.level ?? 'unknown'
  const findings = Array.isArray(result?.findings) ? result.findings : []
  const note = typeof result?.note === 'string' && result.note ? result.note : null

  if (!findings.length) {
    const title = RISK_LABELS[level] ?? RISK_LABELS.unknown
    if (level === 'safe') {
      return {
        title,
        what: '读取文件内容，不会修改任何东西。',
        scope: '当前工作区',
        allow: '允许它读取。文件内容本身不会被改动。',
        deny: '不允许读取，操作会失败。',
        extra: [note].filter(Boolean),
      }
    }
    return {
      title,
      what: '没有识别出这条操作的具体类型。',
      scope: '范围不明，详见下方英文原句',
      allow: '无法预判——请先读一遍下面的英文原句，确认你明白它要做什么再同意。',
      deny: '操作不会执行。在不确定的时候，拒绝是更安全的选择。',
      extra: [note].filter(Boolean),
    }
  }

  const worst = findings.reduce((acc, f) => (SEVERITY[f.level] < SEVERITY[acc.level] ? f : acc), findings[0])
  const rest = findings.filter((f) => f.id !== worst.id)

  return {
    title: RISK_LABELS[worst.level] ?? RISK_LABELS.unknown,
    what: dedupe([worst.what, ...rest.map((f) => `另外还涉及：${f.what}`)]).join(' '),
    scope: scopeFor(worst.id),
    allow: dedupe([worst.allow, ...rest.map((f) => f.allow)]).join(' '),
    deny: dedupe([worst.deny, ...rest.map((f) => f.deny)]).join(' '),
    extra: [note].filter(Boolean),
  }
}

function hintLines(hints) {
  if (!hints.length) return []
  return [`命令里出现了这些项目之外的绝对路径，请确认你是否真的要动它们：${hints.join('  ')}`]
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))]
}

/** The short gloss for a risk level, used under the risk line. */
export function glossFor(level) {
  return RISK_GLOSS[level] ?? RISK_GLOSS.unknown
}
