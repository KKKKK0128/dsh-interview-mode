/**
 * dsh-interview-mode — 离线 battery。
 *
 * 不需要 DSH、不需要音频设备、不需要网络：采集与转写全部用假实现注入引擎，
 * 断言「分段 → 转写 → 判定 → 投递 / 去重 / 补答 / 忙时排队」的行为。
 *
 *   node .test/engine-check.mjs
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { InterviewEngine, isSessionRunning, pickSessionId, sessionTitle } from '../lib/engine.js'
import {
  FOLLOWUP_TAG,
  LONG_TAG,
  QUESTION_TAG,
  detectLanguage,
  looksLikeQuestion,
  normalizeText,
  similarity,
} from '../lib/prompt.js'
import { KNOWLEDGE_TAG, MAX_KNOWLEDGE_PATHS } from '../lib/knowledge.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 异步用例：必须 await，否则断言会脱离调用点（Node 24 会把未处理拒绝当致命错误）。 */
async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

/* ------------------------------------------------------------------ fakes */

function makeCapture(segments) {
  const state = { index: 0, killed: 0, current: null }
  const makeSession = () => {
    const levels = state.current?.levels ?? [
      { t: 0.2, rms: 0.05, db: -26.02 },
      { t: 0.6, rms: 0.09, db: -20.92 },
    ]
    return {
      levels,
      settled: Promise.resolve(),
      lastLevel: () => levels[levels.length - 1],
      stop: async () => {},
      kill: () => { state.killed += 1 },
      stdio: 'pipes',
    }
  }
  return {
    state,
    startCaptureAuto: async () => {
      state.current = segments[state.index] ?? null
      state.index += 1
      return makeSession()
    },
    finishCapture: async () => ({
      seconds: state.current?.seconds ?? 0,
      peak: state.current?.peak ?? 0,
      rms: 0.05,
      path: `C:\\fake\\segment-${state.index}.wav`,
      stream: false,
    }),
    captureWaveBytes: async () => Buffer.from('RIFF____WAVE'),
    discardCapture: () => {},
    listDevices: async () => ({ default: 'fake-default', devices: [] }),
  }
}

function makeSpeech(texts) {
  let index = 0
  return {
    DEFAULT_WAIT_MS: 1000,
    ensureReady: async () => ({ providerId: 'fake', phase: 'ready', language: 'zh', languages: ['zh'] }),
    transcribeWav: async () => {
      const text = texts[index] ?? ''
      index += 1
      return { text, language: 'zh', audioSeconds: 2, inferenceSeconds: 0.05 }
    },
    speechState: () => ({ providerId: 'fake', phase: 'ready', language: 'zh', languages: ['zh'] }),
  }
}

/**
 * 会记录语言提示的假转写器：'en' 提示返回英文、其它返回中文（或 autoText），
 * 用来验证「显式语言生效」与「自动模式英文重转」。
 */
function makeLanguageSpeech(options = {}) {
  const attempts = []
  const chinese = options.chinese ?? '请解释一下这个失配模型？'
  const english = options.english ?? 'Could you explain the mismatch model in your ADC pipeline?'
  const autoText = options.autoText ?? chinese
  return {
    attempts,
    DEFAULT_WAIT_MS: 1000,
    ensureReady: async () => ({ providerId: 'fake', phase: 'ready', language: 'zh', languages: ['zh', 'en'] }),
    transcribeWav: async (_service, _audio, opts = {}) => {
      const language = typeof opts.language === 'string' ? opts.language : ''
      attempts.push(language)
      const text = language === 'en' ? english : autoText
      return { text, language, audioSeconds: 2, inferenceSeconds: 0.05 }
    },
    speechState: () => ({ providerId: 'fake', phase: 'ready', language: 'zh', languages: ['zh', 'en'] }),
  }
}

function makeSessions(records, options = {}) {
  const running = options.running === true
  const sessions = options.sessions ?? [{ sessionId: 's-target', updatedAt: 5, running, blank: false }]
  return {
    // 真实 sessionController 的第二个参数是 AbortSignal 且内部会 throwIfAborted()，
    // 假实现同样要求它非空，否则引擎漏传 signal 时离线测试也会失败。
    list: async (_request, signal) => {
      signal.throwIfAborted()
      return sessions
    },
    prompt: async (request, signal) => {
      signal.throwIfAborted()
      records.push(request)
      return { accepted: true }
    },
    cancel: async () => ({ accepted: true }),
  }
}

function makeEngine(segments, texts, records, options = {}) {
  const capture = makeCapture(segments)
  const speech = makeSpeech(texts)
  const sessions = makeSessions(records, options)
  const engine = new InterviewEngine({
    capture,
    speech,
    speechService: () => ({}),
    sessionController: () => sessions,
    settings: { cooldownMs: 10, ...(options.settings ?? {}) },
  })
  return { engine, capture, speech, sessions }
}

/* ------------------------------------------------------------- pure checks */

console.log('提问判定（第一道闸）')
const questions = [
  '请你介绍一下你在光电硬件方面最擅长的项目经验。',
  '这个 ADC 的采样率是多少？',
  '你为什么选择这个技术路线',
  '讲讲你对 SNR 和 ENOB 的理解',
  '你会怎么排查这个时序问题',
  '能不能说说你的论文创新点',
  '哪些工具你比较熟练',
  '这个项目的难点在哪里呢',
  '有没有做过流片相关的工作',
  'What is your biggest strength',
]
const statements = [
  '我本科就读于山东大学应用物理专业',
  '这个项目做了大约半年时间',
  '我们用了因果时序卷积网络来做校正',
  '数据一共有三组训练集和测试集',
  '我当时负责硬件部分的调试',
  '论文初稿已经写完了',
  '实验室的设备是比较新的',
  '老师建议我把结果整理成图表',
  '今天的面试就到这里吧',
  '这段录音是系统播放出来的',
]
check('10 条提问全部识别为提问', () => {
  for (const text of questions) assert.equal(looksLikeQuestion(text), true, text)
})
check('10 条陈述全部识别为非提问', () => {
  for (const text of statements) assert.equal(looksLikeQuestion(text), false, text)
})

console.log('去重相似度')
check('同一句话（仅标点不同）相似度为 1', () => {
  assert.equal(similarity('请问你叫什么名字？', '请问你叫什么名字'), 1)
})
check('两句话差异明显时相似度低', () => {
  assert.ok(similarity('今天天气不错', '请介绍一下你的项目经历') < 0.2)
})
check('normalizeText 去掉空白与标点', () => {
  assert.equal(normalizeText(' 你好，世界！ Hello, world. '), '你好世界helloworld')
})

console.log('会话选择')
check('pickSessionId 跳过空会话并取最近更新的', () => {
  const list = [
    { sessionId: 'old', updatedAt: 10, blank: false },
    { sessionId: 'blank', updatedAt: 99, blank: true },
    { sessionId: 'new', updatedAt: 50, blank: false },
  ]
  assert.equal(pickSessionId(list), 'new')
})
check('pickSessionId 优先返回面板指定的会话', () => {
  const list = [{ sessionId: 'old', updatedAt: 10 }, { sessionId: 'new', updatedAt: 50 }]
  assert.equal(pickSessionId(list, 'old'), 'old')
})
check('isSessionRunning 只看目标会话', () => {
  const list = [{ sessionId: 'a', running: false }, { sessionId: 'b', running: true }]
  assert.equal(isSessionRunning(list, 'b'), true)
  assert.equal(isSessionRunning(list, 'a'), false)
})

/* ---------------------------------------------------------- engine checks */

console.log('分段引擎')
{
  const records = []
  const segments = [
    { text: '请你介绍一下你在光电硬件方面最擅长的项目经验。', peak: 0.2, seconds: 3 },
    { text: '我本科是应用物理专业，后来读了硕士。', peak: 0.2, seconds: 2 },
    { text: '请你介绍一下你在光电硬件方面最擅长的项目经验', peak: 0.2, seconds: 3 },
  ]
  const { engine } = makeEngine(segments, segments.map((segment) => segment.text), records)
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 3 && engine.delivered >= 1)
  check('提问被投递、陈述不投递、重复问题被去重', () => {
    assert.equal(records.length, 1)
    assert.equal(engine.delivered, 1)
    assert.equal(engine.dropped, 1)
    assert.equal(engine.segments.length, 3)
    assert.equal(engine.segments[0].delivered, true)
    assert.equal(engine.segments[1].reason, 'not-a-question')
    assert.equal(engine.segments[2].reason, 'duplicate')
  })
  check('投递的是带标记的提问消息', () => {
    const text = records[0].content[0].text
    assert.ok(text.startsWith(QUESTION_TAG), text)
    assert.ok(text.includes('光电硬件'), text)
    assert.equal(records[0].sessionId, 's-target')
    assert.equal(records[0].mode, 'queue')
    assert.equal(records[0].content[0].type, 'text')
    assert.equal(typeof records[0].requestId, 'string')
  })
  await checkAsync('热键补答投递最近缓冲内容', async () => {
    const result = await engine.answerLast()
    assert.equal(result.delivered, true)
    assert.equal(records.length, 2)
    const text = records[1].content[0].text
    assert.ok(text.startsWith(FOLLOWUP_TAG), text)
  })
  check('status 快照可供面板渲染', () => {
    const status = engine.status()
    assert.equal(status.state, 'listening')
    assert.equal(status.sessionId, 's-target')
    assert.equal(status.segments.length, 3)
    assert.equal(typeof status.settings.silenceMs, 'number')
    assert.equal(status.preset, undefined)
  })
  await engine.stop()
  check('stop() 之后回到 idle 且不留采集会话', () => {
    assert.equal(engine.state, 'idle')
    assert.equal(engine.status().state, 'idle')
  })
}

console.log('忙时排队与积压丢弃')
{
  const records = []
  const segments = [
    { text: '第一个问题是什么？', peak: 0.2, seconds: 3 },
    { text: '第二个问题怎么处理？', peak: 0.2, seconds: 3 },
    { text: '第三个问题如何优化？', peak: 0.2, seconds: 3 },
  ]
  const { engine } = makeEngine(segments, segments.map((segment) => segment.text), records, { running: true })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 3 && engine.delivered >= 2)
  check('Agent 忙时仍然排队投递，超过 2 条后丢弃最新提问', () => {
    assert.equal(engine.delivered, 2)
    assert.equal(engine.dropped, 1)
    assert.equal(records.length, 2)
    assert.equal(engine.segments[2].reason, 'backlog')
  })
  await engine.stop()
}

console.log('静音段与配置夹取')
{
  const records = []
  const segments = [{
    text: '请问你叫什么名字？',
    peak: 0.0001,
    seconds: 3,
    levels: [{ t: 0.2, rms: 0.00005, db: -86.02 }],
  }]
  const { engine } = makeEngine(segments, ['请问你叫什么名字？'], records)
  await engine.start({ sessionId: 's-target' })
  await sleep(400)
  check('电平过低的分段被丢弃，不进入缓冲也不投递', () => {
    assert.equal(engine.segments.length, 0)
    assert.equal(records.length, 0)
  })
  check('configure 夹取数值区间', () => {
    const settings = engine.configure({ silenceMs: 99999, dupSimilarity: 5, autoAnswer: false, deviceId: null })
    assert.equal(settings.silenceMs, 10000)
    assert.equal(settings.dupSimilarity, 1)
    assert.equal(settings.autoAnswer, false)
    assert.equal(settings.deviceId, '')
  })
  await engine.stop()
}

console.log('选择对话（目标会话）')
{
  const records = []
  const sessions = [
    { sessionId: 's-old', updatedAt: 10, blank: false, title: '旧的面试' },
    { sessionId: 's-new', updatedAt: 90, blank: false, running: true, projections: { values: { title: '新的面试' } } },
    { sessionId: 's-blank', updatedAt: 100, blank: true },
    { sessionId: 's-sub', updatedAt: 110, origin: 'subagent' },
  ]
  const { engine } = makeEngine(
    [{ text: '请解释一下失配模型？', peak: 0.2, seconds: 3 }],
    ['请解释一下失配模型？'],
    records,
    { sessions, settings: { targetSessionId: 's-old' } },
  )
  await engine.start({ sessionId: 's-new' })
  const listing = await engine.listSessions()
  check('listSessions 过滤空/子代理会话、按最近更新排序、标出 current 与 target', () => {
    assert.equal(listing.ok, true)
    assert.equal(listing.error, '')
    assert.deepEqual(listing.items.map((item) => item.sessionId), ['s-new', 's-old'])
    assert.equal(listing.items[0].title, '新的面试')
    assert.equal(listing.items[1].title, '旧的面试')
    assert.equal(listing.items[0].running, true)
    assert.equal(listing.items[0].current, true)
    assert.equal(listing.items[1].target, true)
    assert.equal(listing.current, 's-new')
    assert.equal(listing.target, 's-old')
  })
  await waitFor(() => engine.delivered >= 1)
  check('固定投递的会话优先于最近活动的会话', () => {
    assert.equal(records.length, 1)
    assert.equal(records[0].sessionId, 's-old')
  })
  check('configure 接受 targetSessionId（null 清空回自动）', () => {
    assert.equal(engine.configure({ targetSessionId: 's-new' }).targetSessionId, 's-new')
    assert.equal(engine.configure({ targetSessionId: null }).targetSessionId, '')
    assert.equal(engine.status().targetSessionId, '')
  })
  check('sessionTitle 兼容 title / name / displayTitle / 投影值', () => {
    assert.equal(sessionTitle({ name: '甲' }), '甲')
    assert.equal(sessionTitle({ displayTitle: '乙' }), '乙')
    assert.equal(sessionTitle({ projections: { values: { summary: '丙' } } }), '丙')
    assert.equal(sessionTitle({ title: '   ' }), '')
    assert.equal(sessionTitle({}), '')
  })
  await engine.stop()
}

console.log('固定会话消失时拒绝投递')
{
  const records = []
  const { engine } = makeEngine(
    [{ text: '那这个噪声是怎么处理的？', peak: 0.2, seconds: 3 }],
    ['那这个噪声是怎么处理的？'],
    records,
    { sessions: [{ sessionId: 's-other', updatedAt: 9, blank: false }], settings: { targetSessionId: 's-gone' } },
  )
  await engine.start({ sessionId: 's-other' })
  await waitFor(() => engine.segments.length >= 1 && engine.errors.length >= 1)
  check('选定的对话不存在时宁可报错也不改投到别的会话', () => {
    assert.equal(records.length, 0)
    assert.equal(engine.delivered, 0)
    assert.equal(engine.segments[0].reason, 'no-session')
    assert.ok(engine.errors[0].message.includes('s-gone'), engine.errors[0].message)
  })
  await engine.stop()
}

console.log('英文识别（语言判定与英文提问判定）')
check('detectLanguage 区分中英文与中英混排', () => {
  assert.equal(detectLanguage('What is ENOB and how do you measure it?'), 'en')
  assert.equal(detectLanguage('什么是 ENOB，怎么测？'), 'zh')
  assert.equal(detectLanguage('我们的 ADC 用 SAR 架构，ENOB 大概 10 bit'), 'zh')
  assert.equal(detectLanguage(''), '')
  assert.equal(detectLanguage('12345 ??'), '')
})
check('真实英文面试提问能被判定为提问', () => {
  const english = [
    'Tell me about your experience with deep learning',
    'Could you walk me through your ADC calibration pipeline',
    'What is the biggest challenge you met',
    'How do you handle timing violations',
    'What are the advantages of this architecture',
    'Can you explain the difference between SFDR and ENOB',
  ]
  for (const text of english) assert.equal(looksLikeQuestion(text), true, text)
})
check('英文陈述不误判为提问', () => {
  const statements = [
    'I studied applied physics at Shandong University',
    'We used a causal temporal convolutional network for calibration',
    'The chip was fabricated in a 65 nm CMOS process',
    'My internship was in the hardware team',
  ]
  for (const text of statements) assert.equal(looksLikeQuestion(text), false, text)
})

console.log('英文识别（语言提示与自动重转）')
{
  const speech = makeLanguageSpeech()
  const engine = new InterviewEngine({
    capture: makeCapture([{ text: 'Explain the mismatch model', peak: 0.2, seconds: 3 }]),
    speech,
    speechService: () => ({}),
    sessionController: () => makeSessions([]),
    settings: { cooldownMs: 10, language: 'en', autoAnswer: false },
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 1)
  check('显式 English：转写带 en 提示且不额外重转', () => {
    assert.deepEqual(speech.attempts, ['en'])
    assert.equal(engine.segments[0].lang, 'en')
  })
  await engine.stop()
}
{
  const speech = makeLanguageSpeech({ autoText: 'Could you explain the mismatch model in your ADC pipeline?' })
  const engine = new InterviewEngine({
    capture: makeCapture([{ text: 'auto english', peak: 0.2, seconds: 3 }]),
    speech,
    speechService: () => ({}),
    sessionController: () => makeSessions([]),
    settings: { cooldownMs: 10, language: 'auto', autoAnswer: false },
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 1)
  check('自动模式：英文句子用 en 再转一次，并保留英文结果', () => {
    assert.deepEqual(speech.attempts, ['', 'en'])
    assert.equal(engine.segments[0].lang, 'en')
    assert.ok(engine.segments[0].text.startsWith('Could you explain'), engine.segments[0].text)
  })
  await engine.stop()
}
{
  const speech = makeLanguageSpeech()
  const engine = new InterviewEngine({
    capture: makeCapture([{ text: 'auto chinese', peak: 0.2, seconds: 3 }]),
    speech,
    speechService: () => ({}),
    sessionController: () => makeSessions([]),
    settings: { cooldownMs: 10, language: 'auto', autoAnswer: false },
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 1)
  check('自动模式：中文句子不触发重转', () => {
    assert.deepEqual(speech.attempts, [''])
    assert.equal(engine.segments[0].lang, 'zh')
  })
  await engine.stop()
}

console.log('知识库（选定资料并内联进提问消息）')
{
  const KB_DIR = join(TEST_DIR, 'fixtures')
  const records = []
  const engine = new InterviewEngine({
    capture: makeCapture([{ text: '这个项目的难点在哪里呢？', peak: 0.2, seconds: 3 }]),
    speech: makeSpeech(['这个项目的难点在哪里呢？']),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10, knowledgeBase: KB_DIR },
  })
  check('status 只带知识库摘要，不带内联正文', () => {
    const info = engine.status().knowledge
    assert.equal(info.path, KB_DIR)
    assert.equal(info.kind, 'dir')
    assert.equal(info.included, 1)
    assert.equal(info.totalFiles, 1)
    assert.ok(info.bytes > 0)
    assert.equal('block' in info, false)
  })
  check('知识库结果有热缓存，force 时重算', () => {
    const first = engine.knowledge()
    assert.equal(engine.knowledge(), first)
    assert.notEqual(engine.knowledge(undefined, true), first)
    assert.ok(engine.knowledge().block.includes(KNOWLEDGE_TAG))
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 1 && engine.delivered >= 1)
  check('投递消息附上知识库块，仍以提问标记开头', () => {
    const text = records[0].content[0].text
    assert.ok(text.startsWith(QUESTION_TAG), text)
    assert.ok(text.includes(KNOWLEDGE_TAG), text)
    assert.ok(text.includes('ΔSFDR +14.77 dB'), text)
    assert.ok(text.includes('kb.md'), text)
  })
  await engine.stop()
}
{
  const records = []
  const engine = new InterviewEngine({
    capture: makeCapture([{ text: '介绍一下你自己？', peak: 0.2, seconds: 3 }]),
    speech: makeSpeech(['介绍一下你自己？']),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10 },
  })
  check('configure 接受并规范化 knowledgeBase / knowledgeList', () => {
    const many = Array.from({ length: MAX_KNOWLEDGE_PATHS + 6 }, (_, index) => `C:\\kb\\p${index}`)
    const next = engine.configure({ knowledgeBase: '  "C:\\kb\\a"  ', knowledgeList: many.concat(['c:\\kb\\p0']) })
    assert.equal(next.knowledgeBase, 'C:\\kb\\a')
    assert.equal(next.knowledgeList.length, MAX_KNOWLEDGE_PATHS)
    assert.equal(next.knowledgeList[0], 'C:\\kb\\p0')
    assert.equal(engine.configure({ knowledgeBase: null }).knowledgeBase, '')
  })
  check('未选知识库时不内联任何内容', () => {
    const result = engine.knowledge()
    assert.equal(result.kind, 'empty')
    assert.equal(result.block, '')
    assert.equal(engine.knowledgeSummary().included, 0)
  })
  check('开始监听清空上一次的片段与计数', async () => {
    engine.segments.push({ t: 0, text: '上一轮的残留', peak: 0.2, delivered: true, reason: '' })
    engine.lastText = '上一轮的残留'
    engine.delivered = 3
    engine.dropped = 2
    engine.lastDelivery = { at: 0, text: '残留', ok: true }
    await engine.start({ sessionId: 's-target' })
    assert.equal(engine.segments.length, 0)
    assert.equal(engine.lastText, '')
    assert.equal(engine.delivered, 0)
    assert.equal(engine.dropped, 0)
    assert.equal(engine.lastDelivery, null)
    await engine.stop()
  })
}

console.log('提问灵敏度（strict / standard / high）')
{
  check('标准档把「吗 / 呢 / 么」结尾的句子也算提问', () => {
    for (const text of ['有做过相关的项目吗', '你实习过吗', '用过 Cadence 么', '论文投出去了吗。']) {
      assert.equal(looksLikeQuestion(text, 'standard'), true, text)
    }
  })
  check('保守档不认语气词，只认疑问词', () => {
    assert.equal(looksLikeQuestion('你实习过吗', 'strict'), false)
    assert.equal(looksLikeQuestion('你实习过吗', 'standard'), true)
    assert.equal(looksLikeQuestion('这个项目的难点在哪里呢', 'strict'), true)
  })
  check('标准档新增疑问线索（多大 / 多长 / 讲一下…）', () => {
    for (const text of [
      '这个项目的规模多大',
      '你在这个项目上待了多长时间',
      '再讲一下你的时序收敛流程',
      'How many tape-outs have you done',
    ]) {
      assert.equal(looksLikeQuestion(text, 'standard'), true, text)
    }
  })
  check('高灵敏档认弱话题词与请求式开头', () => {
    for (const text of ['你的优势是什么先不用讲，说说缺点', '规划上没有别的想法了吗', '原因在这里', '你的方案我看看']) {
      assert.equal(looksLikeQuestion(text, 'high'), true, text)
    }
    assert.equal(looksLikeQuestion('你实习过吗', 'standard'), true)
    assert.equal(looksLikeQuestion('具体一点', 'high'), false)
    assert.equal(looksLikeQuestion('我本科就读于山东大学应用物理专业', 'high'), false)
  })
  check('未知档位回落到标准档', () => {
    assert.equal(looksLikeQuestion('你实习过吗', 'banana'), true)
    assert.equal(looksLikeQuestion('我当时负责硬件部分的调试', 'banana'), false)
  })
  check('configure 只接受三个已知档位', () => {
    const engine = new InterviewEngine({
      capture: makeCapture([]),
      speech: makeSpeech([]),
      speechService: () => ({}),
      sessionController: () => makeSessions([]),
      settings: { cooldownMs: 10 },
    })
    assert.equal(engine.settings.questionSensitivity, 'standard')
    assert.equal(engine.settings.minQuestionChars, 4)
    assert.equal(engine.configure({ questionSensitivity: 'HIGH' }).questionSensitivity, 'high')
    assert.equal(engine.configure({ questionSensitivity: 'banana' }).questionSensitivity, 'high')
    assert.equal(engine.configure({ questionSensitivity: null }).questionSensitivity, 'high')
    assert.equal(engine.configure({ questionSensitivity: 'strict' }).questionSensitivity, 'strict')
  })
  const segments = [
    { text: '这个 ADC 的采样率是多少？', peak: 0.2, seconds: 3 },
    { text: '具体一点', peak: 0.2, seconds: 2 },
    { text: '答辩的时候老师问的问题都很简单', peak: 0.2, seconds: 3 },
  ]
  const records = []
  const engine = new InterviewEngine({
    capture: makeCapture(segments),
    speech: makeSpeech(segments.map((item) => item.text)),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10, questionSensitivity: 'high' },
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 3 && engine.delivered + engine.dropped >= 3)
  check('高灵敏档：提问后的短句算追问并投递', () => {
    assert.equal(records.length, 2)
    assert.ok(records[0].content[0].text.startsWith(QUESTION_TAG))
    assert.ok(records[1].content[0].text.startsWith(QUESTION_TAG))
    assert.ok(records[1].content[0].text.includes('具体一点'))
    const promoted = engine.segments.find((item) => item.text === '具体一点')
    assert.equal(promoted.isQuestion, true)
    assert.equal(promoted.promoted, 'follow-up')
  })
  check('高灵敏档：长陈述仍不投递', () => {
    const statement = engine.segments.find((item) => item.text === '答辩的时候老师问的问题都很简单')
    assert.equal(statement.isQuestion, false)
    assert.equal(statement.reason, 'not-a-question')
  })
  await engine.stop()
}
{
  const segments = [
    { text: '这个 ADC 的采样率是多少？', peak: 0.2, seconds: 3 },
    { text: '具体一点', peak: 0.2, seconds: 2 },
  ]
  const records = []
  const engine = new InterviewEngine({
    capture: makeCapture(segments),
    speech: makeSpeech(segments.map((item) => item.text)),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10, questionSensitivity: 'standard' },
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.segments.length >= 2 && engine.delivered + engine.dropped >= 2)
  check('标准档不做追问兜底，短句仍被丢弃', () => {
    assert.equal(records.length, 1)
    const follower = engine.segments.find((item) => item.text === '具体一点')
    assert.equal(follower.isQuestion, false)
    assert.equal(follower.reason, 'not-a-question')
  })
  await engine.stop()
}

console.log('立即回答（结束当前采集段并立即投递）')
{
  // 采集器一直不自己结束（模拟「面试官还在说 / 刚说完、静音判定还没到」），
  // 只有 stop()（＝ answerNow 发出的收尾请求）才会让它结束。
  function makeOpenCapture(seconds) {
    const state = { started: 0, stopped: 0 }
    const capture = {
      state,
      startCaptureAuto: async () => {
        state.started += 1
        let settle = () => {}
        const settled = new Promise((resolve) => { settle = resolve })
        const levels = [{ t: 0.1, rms: 0.06, db: -24 }, { t: 0.3, rms: 0.05, db: -26 }]
        return {
          levels,
          settled,
          lastLevel: () => levels[levels.length - 1],
          stop: async () => {
            state.stopped += 1
            settle()
          },
          kill: () => {},
          stdio: 'pipes',
        }
      },
      finishCapture: async () => ({ seconds, peak: 0.18, rms: 0.05, path: 'C:\\fake\\open.wav', stream: false }),
      captureWaveBytes: async () => Buffer.from('RIFF____WAVE'),
      discardCapture: () => {},
      listDevices: async () => ({ default: 'fake', devices: [] }),
    }
    return capture
  }

  const capture = makeOpenCapture(1.4)
  const records = []
  const engine = new InterviewEngine({
    capture,
    // 这句是陈述句：正常路径下会被 'not-a-question' 丢掉，只有「立即回答」才投递。
    speech: makeSpeech(['我本科是应用物理专业']),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10, silenceMs: 3000 },
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.status().inflight !== null)
  check('采集中 status 报出正在录的这一段', () => {
    const inflight = engine.status().inflight
    assert.notEqual(inflight, null)
    assert.equal(inflight.recording, true)
    assert.equal(typeof inflight.seconds, 'number')
    assert.equal(inflight.transcribing, false)
    assert.equal(inflight.answering, false)
  })
  await checkAsync('answerNow 提前收尾并立即投递（不看提问判定）', async () => {
    const result = await engine.answerNow()
    assert.equal(result.delivered, true, JSON.stringify(result))
    assert.equal(result.text, '我本科是应用物理专业')
    assert.ok(capture.state.stopped >= 1, '应当请求采集器收尾')
    assert.equal(records.length, 1)
    assert.ok(records[0].content[0].text.startsWith(QUESTION_TAG), records[0].content[0].text)
    assert.equal(records[0].sessionId, 's-target')
    const segment = engine.segments[0]
    assert.equal(segment.manual, true)
    assert.equal(segment.isQuestion, true)
    assert.equal(segment.delivered, true)
    assert.equal(segment.reason, 'delivered')
  })
  check('这一段进入记录列表（面板能回看）', () => {
    assert.equal(engine.segments.length, 1)
    assert.equal(engine.status().segments[0].text, '我本科是应用物理专业')
  })
  await engine.stop()
}

{
  // 极短音频（明显误触）仍然不投递，并明确告诉面板「没听到」。
  const capture = {
    startCaptureAuto: async () => {
      let settle = () => {}
      const settled = new Promise((resolve) => { settle = resolve })
      const levels = [{ t: 0.05, rms: 0.02, db: -34 }]
      return { levels, settled, lastLevel: () => levels[0], stop: async () => settle(), kill: () => {}, stdio: 'pipes' }
    },
    finishCapture: async () => ({ seconds: 0.05, peak: 0.02, rms: 0.02, path: 'C:\\fake\\short.wav', stream: false }),
    captureWaveBytes: async () => Buffer.from('RIFF____WAVE'),
    discardCapture: () => {},
    listDevices: async () => ({ default: 'fake', devices: [] }),
  }
  const records = []
  const engine = new InterviewEngine({
    capture,
    speech: makeSpeech(['这一句不该出现']),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10, silenceMs: 3000 },
  })
  await engine.start()
  await waitFor(() => engine.status().inflight !== null)
  await checkAsync('误触级的超短音频不投递（reason nothing-heard）', async () => {
    const result = await engine.answerNow()
    assert.equal(result.delivered, false)
    assert.equal(result.reason, 'nothing-heard')
    assert.equal(records.length, 0)
  })
  await engine.stop()
}

{
  // 没在监听时 answerNow 退化成 answerLast（缓冲为空则明确报错）。
  const engine = new InterviewEngine({
    capture: makeCapture([]),
    speech: makeSpeech([]),
    speechService: () => ({}),
    sessionController: () => makeSessions([]),
    settings: { cooldownMs: 10 },
  })
  await checkAsync('空闲时 answerNow 退化成补答：缓冲为空则报错', async () => {
    await assert.rejects(() => engine.answerNow(), /最近没有可补答的内容/)
  })
}

console.log('长回答（细节描述型的长版本）')
{
  // 同一条提问先自动短答、再点「长回答」：第二次必须换成长回答标记，且不被去重拦掉。
  const records = []
  const engine = new InterviewEngine({
    capture: makeCapture([{ text: '请介绍一下你的项目', seconds: 1.2, peak: 0.2 }]),
    speech: makeSpeech(['请介绍一下你的项目']),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10, minQuestionChars: 4, dupWindowMs: 10000 },
  })
  await engine.start({ sessionId: 's-target' })
  await waitFor(() => engine.delivered === 1)
  await checkAsync('answerLong 用长回答标记重投同一段，且绕过去重', async () => {
    const result = await engine.answerLong(engine.segments[0].text)
    assert.equal(result.delivered, true, JSON.stringify(result))
    assert.equal(records.length, 2)
    assert.ok(records[0].content[0].text.startsWith(QUESTION_TAG), records[0].content[0].text)
    assert.ok(records[1].content[0].text.startsWith(LONG_TAG), records[1].content[0].text)
    assert.ok(records[1].content[0].text.includes('5 分钟口读'), records[1].content[0].text)
    assert.equal(engine.lastDelivery.kind, 'long')
    assert.equal(engine.dropped, 0)
  })
  await checkAsync('answerLong 缺省用最近缓冲区内容', async () => {
    const result = await engine.answerLong()
    assert.equal(result.text, '请介绍一下你的项目')
    assert.equal(result.delivered, true)
    assert.equal(records.length, 3)
  })
  await engine.stop()
}

{
  // 指定片段长答时不受 minQuestionChars 限制（用户明确点了这一条）。
  const records = []
  const engine = new InterviewEngine({
    capture: makeCapture([]),
    speech: makeSpeech([]),
    speechService: () => ({}),
    sessionController: () => makeSessions(records),
    settings: { cooldownMs: 10, minQuestionChars: 20 },
  })
  await checkAsync('answerLong 不看长度闸（用户明确指定片段）', async () => {
    const result = await engine.answerLong('项目难点')
    assert.equal(result.delivered, true)
    assert.equal(records.length, 1)
    assert.ok(records[0].content[0].text.startsWith(LONG_TAG), records[0].content[0].text)
  })
  await checkAsync('缓冲为空时 answerLong 明确报错', async () => {
    await assert.rejects(() => engine.answerLong(), /最近没有可长答的内容/)
  })
}

console.log(`\n${failed === 0 ? 'ALL ENGINE CHECKS PASSED' : 'ENGINE CHECKS FAILED'}  (passed ${passed}, failed ${failed})`)
process.exit(failed === 0 ? 0 : 1)
