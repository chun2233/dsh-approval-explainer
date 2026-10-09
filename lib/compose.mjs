// TODO(restore): 本文件的真实内容尚未传到 GitHub。
//
// 首个提交（e7dac9e）把 lib 下的 7 个代码文件误写成了占位符字符串；
// index.js / rules.mjs / targets.mjs 已在后续提交里补齐，本文件与 all.mjs 还没有。
//
// 完整实现保存在作者的本地工作区：
//   <workspace>\dsh-approval-explainer\lib\compose.mjs
// 以及已安装的 profile 副本：
//   ~/.dsh/profiles/desktop/plugins/dsh-approval-explainer/lib/compose.mjs
//
// 待还原的要点（README 与 CHANGELOG 已描述完整行为）：
//   - composeTitle()：把风险等级词拼进首行标题
//   - resolveLocation()：只对命中规则的内容抽取位置，抽不到就用 scope 短语，绝不编造路径
//   - describeParts()：输出 { title, action, location, rows, allow, deny, extra }
//   - composeExplanation()：按「标题 / AI 将+在哪里 / 同意+拒绝 / 可选块 / 英文原文」分块，
//     块间空一行，MAX_BODY_LINES = 12，超出时从尾部裁剪可选块
//   - prepareCandidate()：幂等检测 + stripOriginalSection 还原

export const MAX_BODY_LINES = 12

throw new Error(
  'lib/compose.mjs 的真实实现尚未恢复到仓库中，详见本文件顶部的 TODO 说明与 README 状态章节',
)
