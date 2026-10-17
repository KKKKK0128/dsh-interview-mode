/**
 * dsh-interview-mode — 离线 battery。
 *
 * 不需要 DSH、不需要音频设备、不需要网络：采集与转写全部用假实现注入引擎，
 * 断言「分段 → 转写 → 判定 → 投递 / 去重 / 补答 / 忙时排队」的行为。
 *
 *   node .test/engine-check.mjs
 */

import assert from 'node:assert/strict'

import { InterviewEngine, isSessionRunning, pickSessionId, sessionTitle } from '../lib/engine.js'
import {
  FOLLOWUP_TAG,
  QUESTION_TAG,
  detectLanguage,
  looksLikeQuestion,
  normalizeText,
  similarity,
} from '../lib/prompt.js'

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

console.log(`\n${failed === 0 ? 'ALL ENGINE CHECKS PASSED' : 'ENGINE CHECKS FAILED'}  (passed ${passed}, failed ${failed})`)
process.exit(failed === 0 ? 0 : 1)
