/**
 * dsh-interview-mode — 模式提示词 / 提问判定 / 文本相似度。
 *
 * 本文件全部是纯函数与常量，不依赖 DSH、不依赖宿主，便于离线 battery 直接测试。
 */

/** 模式（agent preset）的身份。 */
export const PRESET_ID = 'mock-interview'
export const PRESET_NAME = '模拟面试模式'
export const PRESET_DESCRIPTION = '实时采集电脑播放的声音，把面试官提问自动交给当前会话的 Agent 回答'
export const PRESET_ORDER = 50

/** 注入到系统提示词里的段名与顺序。 */
export const PROMPT_SECTION_NAME = 'interview-mode'
export const PROMPT_SECTION_ORDER = 30

/** 投递到会话时不加引号的标记，Agent 靠它识别「这是机器听来的提问」。 */
export const QUESTION_TAG = '[模拟面试·面试官提问]'
export const FOLLOWUP_TAG = '[模拟面试·补答请求]'
/** 用户在面板上点「长回答」时的标记：同一条提问的细节描述型长版本。 */
export const LONG_TAG = '[模拟面试·长回答请求]'
export const SOURCE_NOTE = '（来源：电脑音频自动转写，可能有错字；请直接给出可照读的口语化回答）'
/** 长回答请求附带的长度要求。 */
export const LONG_NOTE = '（要求：细节描述型的长回答，按 5 分钟口读准备；不要编造数据）'

/** 模式提示词全文（只在收到带标记的消息时生效，因此全局注入也无副作用）。 */
export const INTERVIEW_PROMPT = `你是「模拟面试模式」里的面试副手。

当收到以 ${QUESTION_TAG}、${FOLLOWUP_TAG} 或 ${LONG_TAG} 开头的消息时：
1. 立刻给出**可直接照读**的口语化回答：中文提问用中文，长度 500–800 字（口读约 2.5–4 分钟；**硬上限 1200 字，约 5 分钟**）；英文提问用英文，约 300–500 词（硬上限约 750 词）；
2. 结构：先一句结论/定义，再 2–4 个要点，每个要点都给细节（数字、取舍、踩过的坑），必要时补一个例子；
3. 不要复述问题，不要寒暄，不要「好的/当然可以」这类开场；
4. 不要调用工具、不要反问、不要要求澄清；信息不足时按最合理的常识假设作答；
5. 技术问题优先给：定义 → 原理/流程 → 常见坑 → 一句话总结；
6. 若同一条提问与上文高度重复，用一句话补充差异点即可；
7. 回答语言跟随提问语言（中文提问答中文、英文提问答英文，中英混合以中文为主，关键术语可保留英文）；
8. 若消息里带 [知识库] 段，先按其中资料作答（事实、数字、结论以资料为准），资料里没有的再按常识补充，不要编造具体数据；
9. 若以 ${LONG_TAG} 开头（用户在面板上点了「长回答」）：给细节描述型的长版本，按 5 分钟口读准备——中文 1000–1200 字、英文约 650–750 词；结构固定为「结论 → 背景与目标 → 方案与关键细节（数字、取舍、失败与修复）→ 结果与一句话收尾」；比短版本多出来的是过程与细节，不是形容词。

除以上消息外，保持正常的编程助手行为。`

/** 去重默认阈值（字符 bigram Dice 相似度）。 */
export const DEFAULT_DUP_SIMILARITY = 0.9

/**
 * 提问灵敏度档位。
 *
 * - strict：只认强疑问线索（疑问词 / 请求式动词 / 话题词）；
 * - standard（默认）：再加结尾疑问语气词（吗 / 呢 / 么）；
 * - high：再加弱话题词、请求式开头，并由引擎做「刚问过就再补一句」的追问兜底。
 */
export const DEFAULT_QUESTION_SENSITIVITY = 'standard'
export const QUESTION_SENSITIVITIES = ['strict', 'standard', 'high']

/** 强疑问线索：命中即基本可以确定是提问。 */
const CJK_HINTS = [
  '什么', '怎么', '怎样', '为什么', '为何', '如何', '哪些', '哪个', '哪一', '哪几', '哪方面',
  '谁', '多少', '多大', '多长', '多长时间', '多久', '哪里', '几点',
  '介绍', '说说', '讲讲', '谈谈', '讲一讲', '讲一下', '讲下', '说一下', '说下', '聊一聊',
  '聊一下', '聊下', '谈一谈', '展开讲', '细讲', '详细讲', '详细说', '举例', '举个例子',
  '比方说', '区别', '差异', '优缺点', '是否', '能否', '能不能', '可以吗', '好吗', '对不对',
  '是不是', '有没有', '会不会', '行不行', '好不好', '对吗', '是吧',
  '了解一下', '请你', '请问', '你会', '你能', '你觉得', '怎么办', '怎么样', '怎么看',
  '怎么理解', '怎么解决', '怎么处理', '怎么选', '描述', '阐述', '解释', '评价',
  '做过', '用过', '遇到过',
]

/** 弱线索：面试话题名词，单独出现只算「可能」。只在 high 档启用（多报可忽略，漏报才是损失）。 */
const CJK_WEAK_HINTS = [
  '优势', '劣势', '缺点', '优点', '特点', '亮点', '难点', '重点', '原因', '意义', '作用',
  '规模', '原理', '流程', '思路', '方案', '收获', '体会', '感受', '看法', '想法', '建议',
  '规划', '打算', '挑战',
]
const EN_HINTS = [
  // 疑问词 / 情态开头
  'what', 'why', 'how', 'when', 'where', 'which', 'who', 'whose', 'how much', 'how many',
  'how long', 'how do you', 'how would you', 'how did you', 'what is', "what's", 'what are',
  'why do', 'why did', 'which one', 'what kind', 'what sort', 'do you have', 'have you ever',
  // 请求式
  'can you', 'could you', 'would you', 'will you', 'do you', 'did you', 'have you',
  'are you', 'tell me', 'tell us', 'talk me through', 'talk about', 'walk me through',
  'give me', 'show me', 'could you describe', 'can you explain',
  // 任务式动词
  'describe', 'explain', 'introduce', 'summarize', 'summary', 'outline', 'compare',
  // 面试常问话题
  'difference', 'advantage', 'disadvantage', 'pros and cons', 'trade-off', 'tradeoff',
  'experience', 'challenge', 'difficulty', 'achievement', 'strength', 'weakness',
  'example', 'for instance', 'in your opinion', 'what do you think',
]
/** 英文弱线索（仅 high 档）。 */
const EN_WEAK_HINTS = [
  'background', 'motivation', 'goal', 'plan', 'impact', 'result', 'project', 'pipeline',
  'architecture', 'team', 'timeline', 'salary', 'reason', 'approach', 'tool',
]

/** 结尾疑问语气词（去掉句末标点后再看）。 */
const QUESTION_PARTICLES = /[吗呢么]$/
/** 半角/全角句末标点，用于取出语气词。 */
const TRAILING_PUNCTUATION = /[。．.!！?？,，、;；:：~～\s]+$/g
/** 请求式开头（仅 high 档）。 */
const CJK_REQUEST_PREFIX = /^(请|你|您|能|可以|是否|有没有|会不会|能不能|介绍|说说|讲讲|聊|谈|描述|解释|评价|阐述)/
const EN_REQUEST_PREFIX = /^(can|could|would|will|do|did|does|have|has|are|is|what|why|how|when|where|which|who|tell|talk|walk|give|show|describe|explain|introduce|summarize)\b/

/** 中日韩表意文字（含扩展 A 区与兼容区），用于语言判定。 */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN_PATTERN = /[a-z]/i

const PUNCTUATION = /[\s\u3000-\u303f\uff00-\uffef!-/:-@[-`{-~]/g

/**
 * 判别说出的这段话是不是一个提问（第一道闸，零成本）。
 *
 * 宁可多报也不要漏报：漏报会让面试官的问题被当成陈述丢掉，而误报只是多一条
 * 可忽略的投递（还有去重与结果确认兜底）。
 *
 * @param {string} text 转写文本
 * @param {'strict'|'standard'|'high'} [sensitivity] 灵敏度档位，默认 standard
 * @returns {boolean}
 */
export function looksLikeQuestion(text, sensitivity = DEFAULT_QUESTION_SENSITIVITY) {
  const raw = String(text ?? '').trim()
  if (raw === '') return false
  if (/[?？]/.test(raw)) return true
  const level = QUESTION_SENSITIVITIES.includes(sensitivity)
    ? sensitivity
    : DEFAULT_QUESTION_SENSITIVITY
  if (raw.length < (level === 'strict' ? 4 : 3)) return false
  const lower = raw.toLowerCase()
  if (EN_HINTS.some((hint) => lower.includes(hint))) return true
  if (CJK_HINTS.some((hint) => raw.includes(hint))) return true
  if (level === 'strict') return false
  // standard：结尾的「吗 / 呢 / 么」几乎只在提问里出现（「吧」不算，陈述句也会用）。
  if (QUESTION_PARTICLES.test(raw.replace(TRAILING_PUNCTUATION, ''))) return true
  if (level !== 'high') return false
  if (CJK_WEAK_HINTS.some((hint) => raw.includes(hint))) return true
  if (EN_WEAK_HINTS.some((hint) => lower.includes(hint))) return true
  return CJK_REQUEST_PREFIX.test(raw) || EN_REQUEST_PREFIX.test(lower)
}

/**
 * 粗判一段转写的语言：'zh' / 'en' / ''（认不出）。
 *
 * 只用来决定「要不要换英文提示重转一次」以及界面上显示语言，不参与提问判定。
 * 英文单词平均 4–5 个字母，所以中英混排时拉丁字母数达到汉字数 2 倍才算英文。
 *
 * @param {string} text
 * @returns {'zh'|'en'|''}
 */
export function detectLanguage(text) {
  const raw = String(text ?? '')
  let cjk = 0
  let latin = 0
  for (const char of raw) {
    if (CJK_PATTERN.test(char)) cjk += 1
    else if (LATIN_PATTERN.test(char)) latin += 1
  }
  if (cjk === 0 && latin === 0) return ''
  if (latin === 0) return 'zh'
  if (cjk === 0) return 'en'
  return latin >= cjk * 2 ? 'en' : 'zh'
}

/**
 * 归一化：去掉空白与中英文标点、统一小写。用于去重比较。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '').toLowerCase().replace(PUNCTUATION, '')
}

function bigrams(text) {
  const grams = new Map()
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  return grams
}

/**
 * 字符 bigram Dice 相似度，0–1。中文短句上足够判别「同一句话被听了两遍」。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function similarity(left, right) {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (a === '' || b === '') return a === b ? 1 : 0
  if (a === b) return 1
  const gramsA = bigrams(a)
  const gramsB = bigrams(b)
  let overlap = 0
  let total = 0
  for (const [gram, count] of gramsA) {
    total += count
    const other = gramsB.get(gram)
    if (other !== undefined) overlap += Math.min(count, other)
  }
  for (const count of gramsB.values()) total += count
  return total === 0 ? 0 : (2 * overlap) / total
}

/**
 * @param {string} left
 * @param {string} right
 * @param {number} threshold
 * @returns {boolean}
 */
export function isDuplicate(left, right, threshold = DEFAULT_DUP_SIMILARITY) {
  return similarity(left, right) >= threshold
}

/** 组装投递给会话的自动提问文本。 */
export function formatQuestion(text) {
  return `${QUESTION_TAG} ${String(text ?? '').trim()}\n${SOURCE_NOTE}`
}

/** 组装投递给会话的热键补答文本。 */
export function formatFollowUp(text) {
  return `${FOLLOWUP_TAG} ${String(text ?? '').trim()}\n${SOURCE_NOTE}`
}

/** 组装「长回答」请求：同一条提问的细节描述型长版本。 */
export function formatLongAnswer(text) {
  return `${LONG_TAG} ${String(text ?? '').trim()}\n${LONG_NOTE}`
}
