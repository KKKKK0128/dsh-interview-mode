/**
 * dsh-interview-mode — 分段引擎（核心状态机）。
 *
 *   idle ──start()──> listening ──每段：采集 → 转写 → 判定 → 投递──> listening
 *      ▲                                                            │
 *      └──────────────────────── stop() ────────────────────────────┘
 *
 * 采集/转写由 dsh-system-audio 提供，但这里**只通过构造参数接收**（capture /
 * speech / speechService / sessionController），所以离线可以用假实现完整测试。
 *
 * 每段的结束判定复用采集器已经验证过的 `silenceStopMs`（静音自动停止），而不是
 * 自己写流式 VAD —— 风险最低，代价是每段有 ~0.3 s 的转写延迟。
 */

import { randomUUID } from 'node:crypto'

import { collectKnowledge, normalizeKnowledgeList, normalizeKnowledgePath } from './knowledge.js'
import {
  DEFAULT_DUP_SIMILARITY,
  DEFAULT_QUESTION_SENSITIVITY,
  QUESTION_SENSITIVITIES,
  detectLanguage,
  formatFollowUp,
  formatLongAnswer,
  formatQuestion,
  looksLikeQuestion,
  normalizeText,
  similarity,
} from './prompt.js'

export const DEFAULT_SETTINGS = {
  deviceId: '',
  // '' = 跟随当前会话（每次投递时解析最近活动的会话）；非空 = 固定投递到这个会话。
  targetSessionId: '',
  autoStart: false,
  autoAnswer: true,
  // 段结束判定：静音超过这么久才算一句话说完。面试官提问中间常有 0.5–1 s 的
  // 思考停顿，取 700 ms 会把一句话切成两段（前半段丢掉、后半段不像提问），
  // 所以默认放宽到 1000 ms；代价是每段多 ~0.3 s 的等待。
  silenceMs: 1000,
  minSpeechMs: 800,
  minPeakRms: 0.008,
  maxSegmentMs: 30000,
  cooldownMs: 300,
  dupSimilarity: DEFAULT_DUP_SIMILARITY,
  dupWindowMs: 10000,
  minQuestionChars: 4,
  // 提问判定灵敏度：strict / standard / high（见 lib/prompt.js）。
  questionSensitivity: DEFAULT_QUESTION_SENSITIVITY,
  maxBufferSeconds: 30,
  maxSegments: 60,
  interruptWhenBusy: false,
  language: 'auto',
  hotkey: 'Ctrl+Shift+I',
  // 知识库：'' = 不使用；knowledgeBase 是当前选中的文件夹/文件，
  // knowledgeList 是面板里保存过的候选路径（下拉框选项）。
  knowledgeBase: '',
  knowledgeList: [],
}

const REPORT_SEGMENTS = 12
const MAX_ERRORS = 20
const LEVEL_TICK_MS = 120
/** 知识库资料的缓存时间：面板轮询频繁，避免每次 status 都去读磁盘。 */
const KNOWLEDGE_CACHE_MS = 10000
/** high 灵敏度下，上一段提问之后多久内的短句算追问。 */
const FOLLOWUP_WINDOW_MS = 10000
const MAX_CAPTURE_SECONDS = 300
const MIN_CAPTURE_SECONDS = 5
/** 「立即回答」时允许的最短音频：比这还短基本是误触，直接丢掉。 */
const FORCE_MIN_AUDIO_SECONDS = 0.2
/** 「立即回答」最多等当前这段转写多久（转写本身通常 <0.5 s，留足余量）。 */
const ANSWER_NOW_TIMEOUT_MS = 12000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 统计拉丁字母数，用来比较两次转写哪一次更像英文。 */
const countLatin = (text) => {
  let count = 0
  for (const char of String(text ?? '')) if (/[a-z]/i.test(char)) count += 1
  return count
}

const decibels = (rms) => {
  const value = Number.isFinite(rms) && rms > 0 ? rms : 0
  return value <= 0 ? -120 : 20 * Math.log10(value)
}

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

function normalizeList(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.sessions)) return value.sessions
  if (Array.isArray(value?.items)) return value.items
  return []
}

/**
 * 从 `sessionController.list()` 的返回里挑一个可以投递的会话：优先最近更新的
 * 非空会话。会话列表的形状随版本变化，这里对数组 / {sessions} / {items} 都兼容。
 *
 * @param {unknown} value list() 的返回值
 * @param {string} [preferred] 面板指定的会话 id
 * @returns {string} 会话 id，找不到返回 ''
 */
export function pickSessionId(value, preferred = '') {
  const items = normalizeList(value)
  if (typeof preferred === 'string' && preferred !== '') {
    const hit = items.find((item) => item?.sessionId === preferred)
    if (hit !== undefined || items.length === 0) return preferred
  }
  const usable = items.filter((item) => (
    typeof item?.sessionId === 'string' && item.sessionId !== '' && item.blank !== true
  ))
  if (usable.length === 0) return ''
  const sorted = [...usable].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
  return sorted[0].sessionId
}

/**
 * 目标会话是否正忙（Agent 正在回答上一问）。
 *
 * @param {unknown} value list() 的返回值
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionRunning(value, sessionId) {
  const hit = normalizeList(value).find((item) => item?.sessionId === sessionId)
  return hit?.running === true
}

/**
 * 会话标题在不同 DSH 版本里可能挂在 title / name / displayTitle 或投影值上，
 * 这里都探测一遍；取不到就让面板退化成「短 id + 时间」。
 *
 * @param {any} item sessionController.list() 的一行
 * @returns {string}
 */
export function sessionTitle(item) {
  const candidates = [item?.title, item?.name, item?.displayTitle];
  const values = item?.projections?.values
  if (values !== null && typeof values === 'object') {
    candidates.push(values.title, values.name, values.summary)
  }
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

export class InterviewEngine {
  #capture

  #speech

  #speechService

  #sessionController

  #log

  #signal = null

  #loop = null

  #session = null

  #queuedWhileBusy = 0

  #knowledgeCache = null

  /** 当前这一轮采集（#run 每次循环重建），供 answerNow() 判断「有没有正在采的段」。 */
  #cycle = null

  /** 「立即回答」按下后，这一段不再等静音、也无视 minSpeechMs / 提问判定。 */
  #forceRequested = false

  /** 等待当前段转写完成的 pending 请求 { resolve, promise, timer }。 */
  #forceWait = null

  /** 当前采集段的开始时间，用来给面板报「已录 x.x s」。 */
  #captureStartedAt = 0

  /** 是否正在跑语音转写（面板显示「正在转写…」）。 */
  #transcribing = false

  /**
   * @param {object} deps
   * @param {object} deps.capture dsh-system-audio/recorder 的导出
   * @param {object} deps.speech dsh-system-audio/speech 的导出
   * @param {() => object|undefined} [deps.speechService] 取 speechToText 宿主服务
   * @param {() => object|undefined} [deps.sessionController] 取 sessionController 宿主服务
   * @param {(message: string) => void} [deps.logger]
   * @param {Partial<typeof DEFAULT_SETTINGS>} [deps.settings]
   */
  constructor(deps = {}) {
    if (!deps.capture) throw new Error('InterviewEngine 需要 capture 依赖')
    if (!deps.speech) throw new Error('InterviewEngine 需要 speech 依赖')
    this.#capture = deps.capture
    this.#speech = deps.speech
    this.#speechService = typeof deps.speechService === 'function' ? deps.speechService : () => undefined
    this.#sessionController = typeof deps.sessionController === 'function' ? deps.sessionController : () => undefined
    this.#log = typeof deps.logger === 'function' ? deps.logger : () => {}
    this.settings = { ...DEFAULT_SETTINGS, ...(deps.settings ?? {}) }
    // 复制一份：DEFAULT_SETTINGS 里的数组是共享引用，不能让两个引擎共用。
    this.settings.knowledgeList = normalizeKnowledgeList(this.settings.knowledgeList)
    this.state = 'idle'
    this.sessionId = ''
    this.level = { t: 0, rms: 0, db: -120 }
    this.lastText = ''
    this.segments = []
    this.errors = []
    this.delivered = 0
    this.dropped = 0
    this.startedAt = 0
    this.lastDelivery = null
  }

  /** 给面板看的状态快照。 */
  status() {
    return {
      ok: true,
      state: this.state,
      sessionId: this.sessionId,
      targetSessionId: this.settings.targetSessionId,
      deviceId: this.settings.deviceId,
      level: { ...this.level },
      lastText: this.lastText,
      delivered: this.delivered,
      dropped: this.dropped,
      startedAt: this.startedAt,
      errors: this.errors.slice(-5),
      settings: { ...this.settings },
      knowledge: this.knowledgeSummary(),
      // 正在采的这一段（面板据此显示「录音中 x.x s · 正在转写」与「立即回答」按钮）。
      inflight: this.#inflight(),
      segments: this.segments.slice(-REPORT_SEGMENTS).reverse(),
    }
  }

  /** 当前采集段的状态；没有在采也没有在转写时返回 null。 */
  #inflight() {
    const recording = this.#session !== null
    if (!recording && !this.#transcribing) return null
    const seconds = recording && this.#captureStartedAt > 0
      ? (Date.now() - this.#captureStartedAt) / 1000
      : 0
    return {
      recording,
      seconds: Math.round(Math.max(0, seconds) * 10) / 10,
      transcribing: this.#transcribing,
      answering: this.#forceWait !== null,
    }
  }

  /**
   * 读取（或复用缓存里的）知识库资料。面板用它显示「已内联 N/M 个文件」，
   * 投递时用它的 block 作为消息正文里的资料段。
   *
   * @param {string} [path] 指定路径；不传则用当前配置
   * @param {boolean} [force] 跳过热缓存（面板手动刷新 / 测试用）
   * @returns {object} collectKnowledge 的结果
   */
  knowledge(path, force = false) {
    const target = path === undefined || path === null
      ? this.settings.knowledgeBase
      : normalizeKnowledgePath(path)
    const now = Date.now()
    const cache = this.#knowledgeCache
    if (force !== true && cache !== null && cache.path === target && now - cache.at < KNOWLEDGE_CACHE_MS) {
      return cache.result
    }
    let result
    try {
      result = collectKnowledge(target)
    } catch (error) {
      result = {
        path: normalizeKnowledgePath(target),
        kind: 'other',
        error: error instanceof Error ? error.message : String(error),
        files: [],
        totalFiles: 0,
        included: 0,
        bytes: 0,
        truncated: false,
        block: '',
      }
    }
    this.#knowledgeCache = { path: target, at: now, result }
    return result
  }

  /** 面板状态里的知识库摘要（不含内联正文，否则每次轮询都传几十 KB）。 */
  knowledgeSummary() {
    const result = this.knowledge()
    return {
      path: result.path,
      kind: result.kind,
      error: result.error,
      included: result.included,
      totalFiles: result.totalFiles,
      bytes: result.bytes,
      truncated: result.truncated,
    }
  }

  /**
   * 面板「选择对话」用的会话清单。返回可直接下拉渲染的行，顺带告诉面板
   * 当前监听会话（current）与固定投递会话（target）。
   *
   * @returns {Promise<{ ok: boolean, current: string, target: string, error: string, items: object[] }>}
   */
  async listSessions() {
    const out = { ok: true, current: this.sessionId, target: this.settings.targetSessionId, error: '', items: [] }
    const controller = this.#sessionController()
    if (!controller || typeof controller.list !== 'function') {
      out.ok = false
      out.error = '当前组合里没有 sessionController 服务，无法读取会话列表'
      return out
    }
    const signal = this.#signal?.signal ?? new AbortController().signal
    try {
      const list = await controller.list(undefined, signal)
      out.items = normalizeList(list)
        .filter((item) => (
          typeof item?.sessionId === 'string' && item.sessionId !== ''
          && item.blank !== true && item.origin !== 'subagent'
        ))
        .map((item) => ({
          sessionId: item.sessionId,
          title: sessionTitle(item),
          updatedAt: Number(item.updatedAt ?? 0) || 0,
          running: item.running === true,
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          current: item.sessionId === this.sessionId,
          target: item.sessionId === this.settings.targetSessionId,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (error) {
      out.ok = false
      out.error = error instanceof Error ? error.message : String(error)
    }
    return out
  }

  /**
   * 合并配置补丁（面板改配置走这里）。未知键被忽略，数值会被夹到安全区间。
   *
   * @param {object} patch
   * @returns {object} 合并后的 settings
   */
  configure(patch = {}) {
    const next = { ...this.settings }
    if (patch.deviceId !== undefined) next.deviceId = patch.deviceId === null ? '' : String(patch.deviceId)
    if (patch.targetSessionId !== undefined) {
      next.targetSessionId = patch.targetSessionId === null ? '' : String(patch.targetSessionId)
    }
    if (patch.language !== undefined && patch.language !== null) next.language = String(patch.language) || 'auto'
    if (patch.questionSensitivity !== undefined && patch.questionSensitivity !== null) {
      const level = String(patch.questionSensitivity).trim().toLowerCase()
      if (QUESTION_SENSITIVITIES.includes(level)) next.questionSensitivity = level
    }
    if (patch.hotkey !== undefined && patch.hotkey !== null) next.hotkey = String(patch.hotkey) || DEFAULT_SETTINGS.hotkey
    if (patch.knowledgeBase !== undefined) next.knowledgeBase = normalizeKnowledgePath(patch.knowledgeBase)
    if (patch.knowledgeList !== undefined) next.knowledgeList = normalizeKnowledgeList(patch.knowledgeList)
    if (patch.autoStart !== undefined) next.autoStart = asBoolean(patch.autoStart, next.autoStart)
    if (patch.autoAnswer !== undefined) next.autoAnswer = asBoolean(patch.autoAnswer, next.autoAnswer)
    if (patch.interruptWhenBusy !== undefined) next.interruptWhenBusy = asBoolean(patch.interruptWhenBusy, next.interruptWhenBusy)
    if (patch.silenceMs !== undefined) next.silenceMs = clampNumber(patch.silenceMs, 250, 10000, next.silenceMs)
    if (patch.minSpeechMs !== undefined) next.minSpeechMs = clampNumber(patch.minSpeechMs, 0, 10000, next.minSpeechMs)
    if (patch.minPeakRms !== undefined) next.minPeakRms = clampNumber(patch.minPeakRms, 0, 1, next.minPeakRms)
    if (patch.maxSegmentMs !== undefined) next.maxSegmentMs = clampNumber(patch.maxSegmentMs, 2000, 300000, next.maxSegmentMs)
    if (patch.cooldownMs !== undefined) next.cooldownMs = clampNumber(patch.cooldownMs, 0, 5000, next.cooldownMs)
    if (patch.dupSimilarity !== undefined) next.dupSimilarity = clampNumber(patch.dupSimilarity, 0, 1, next.dupSimilarity)
    if (patch.dupWindowMs !== undefined) next.dupWindowMs = clampNumber(patch.dupWindowMs, 0, 120000, next.dupWindowMs)
    if (patch.minQuestionChars !== undefined) next.minQuestionChars = clampNumber(patch.minQuestionChars, 1, 200, next.minQuestionChars)
    if (patch.maxBufferSeconds !== undefined) next.maxBufferSeconds = clampNumber(patch.maxBufferSeconds, 5, 600, next.maxBufferSeconds)
    this.settings = next
    return this.settings
  }

  /**
   * 开始监听。
   *
   * @param {{ sessionId?: string, deviceId?: string| null }} [options]
   */
  async start(options = {}) {
    if (typeof options.sessionId === 'string' && options.sessionId !== '') this.sessionId = options.sessionId
    if (options.deviceId !== undefined && options.deviceId !== null) this.settings.deviceId = String(options.deviceId)
    if (this.state === 'listening') return this.status()
    this.state = 'listening'
    this.errors = []
    // 每次重新开始监听都丢掉上一次的记录（用户要求：不保留上次监听的记录）。
    this.segments = []
    this.lastText = ''
    this.delivered = 0
    this.dropped = 0
    this.lastDelivery = null
    this.startedAt = Date.now()
    this.#queuedWhileBusy = 0
    this.#forceRequested = false
    this.#captureStartedAt = 0
    this.#transcribing = false
    this.#settleForce({ ok: false, delivered: false, text: '', reason: 'stopped' })
    this.#signal = new AbortController()
    this.#loop = this.#run(this.#signal.signal).catch((error) => this.#fail(error))
    return this.status()
  }

  /** 停止监听：杀掉正在采集的那一段并等待循环退出。 */
  async stop() {
    if (this.state !== 'listening') return this.status()
    this.state = 'idle'
    try {
      this.#signal?.abort()
    } catch {
      /* already aborted */
    }
    const session = this.#session
    this.#session = null
    if (session) {
      try {
        session.kill()
      } catch {
        /* already gone */
      }
    }
    try {
      await this.#loop
    } catch {
      /* the loop already reported its failure */
    }
    this.#loop = null
    this.#signal = null
    this.#forceRequested = false
    this.#captureStartedAt = 0
    this.#transcribing = false
    this.#settleForce({ ok: false, delivered: false, text: '', reason: 'stopped' })
    this.level = { t: 0, rms: 0, db: -120 }
    return this.status()
  }

  /**
   * 立即回答：不再等静音切段，马上结束当前这一轮采集并投递它。
   *
   * 典型场景是面试官提问完停在那里、或者面试官说完最后一句时你判断这句话该答了：
   * 按热键（Ctrl+Shift+U）/点按钮即可，这一段会**无视 minSpeechMs 与提问判定**直接投递。
   * 采集中但还没到可转写的长度（< FORCE_MIN_AUDIO_SECONDS）时返回空结果。
   *
   * @returns {Promise<{ ok: true, delivered: boolean, text: string, reason?: string }>}
   */
  async answerNow() {
    // 没在监听（或当前轮已经采完在等待下一轮）时，退回「补答最近缓冲」。
    if (this.state !== 'listening' || this.#session === null) return this.answerLast()
    if (this.#forceWait !== null) return this.#forceWait.promise
    let resolve
    const promise = new Promise((settle) => { resolve = settle })
    const timer = setTimeout(() => {
      this.#settleForce({ ok: true, delivered: false, text: '', reason: 'timeout' })
    }, ANSWER_NOW_TIMEOUT_MS)
    if (typeof timer?.unref === 'function') timer.unref()
    this.#forceWait = { resolve, promise, timer }
    this.#forceRequested = true
    const session = this.#session
    if (session && typeof session.stop === 'function') {
      try {
        // 采集器会被请求收尾：它把已录到的音频交回来，随后被当作「这句话说完了」处理。
        await session.stop()
      } catch {
        /* 采集器可能已经自己结束了 */
      }
    }
    return promise
  }

  /** 结算一次「立即回答」；没有 pending 请求时什么都不做。 */
  #settleForce(result) {
    const wait = this.#forceWait
    if (wait === null) return
    this.#forceWait = null
    if (wait.timer !== null) clearTimeout(wait.timer)
    wait.resolve(result)
  }

  /**
   * 热键补答：把最近 `maxBufferSeconds` 内听过的内容再投一次。
   *
   * @returns {Promise<{ ok: true, delivered: boolean, text: string }>}
   */
  async answerLast() {
    const deadline = Date.now() - this.settings.maxBufferSeconds * 1000
    const recent = this.segments.filter((segment) => segment.t >= deadline && segment.text !== '')
    const text = recent.map((segment) => segment.text).join(' ').trim()
    if (text === '') throw new Error('最近没有可补答的内容（缓冲区为空）')
    const value = await this.#deliver(text, 'followup')
    return { ok: true, delivered: value !== null, text }
  }

  /**
   * 长回答：把指定片段（缺省＝最近缓冲区）再投一次，要求细节描述型的长版本
   * （按 5 分钟口读准备）。这是用户明确要求的动作，因此和补答一样不看提问判定，
   * 也不走去重——同一句话可以先短答、再点「长回答」展开一遍。
   *
   * @param {string} [text] 指定片段原文；省略时用最近 `maxBufferSeconds` 内的内容。
   * @returns {Promise<{ ok: true, delivered: boolean, text: string }>}
   */
  async answerLong(text) {
    const explicit = String(text ?? '').trim()
    let body = explicit
    if (body === '') {
      const deadline = Date.now() - this.settings.maxBufferSeconds * 1000
      const recent = this.segments.filter((segment) => segment.t >= deadline && segment.text !== '')
      body = recent.map((segment) => segment.text).join(' ').trim()
    }
    if (body === '') throw new Error('最近没有可长答的内容（缓冲区为空）')
    const value = await this.#deliver(body, 'long')
    return { ok: true, delivered: value !== null, text: body }
  }

  async #run(signal) {
    while (!signal.aborted && this.state === 'listening') {
      let segment = null
      let failure = null
      // 把「这一轮采集」登记下来，answerNow() 才能等到它转写完再回答。
      let settleCycle = () => {}
      const cycle = new Promise((resolve) => { settleCycle = resolve })
      this.#cycle = cycle
      try {
        segment = await this.#captureSegment(signal)
      } catch (error) {
        failure = error
      } finally {
        this.#cycle = null
        settleCycle()
      }
      if (failure) {
        this.#fail(failure)
        if (this.#forceRequested) {
          this.#forceRequested = false
          this.#settleForce({ ok: false, delivered: false, text: '', reason: 'failed' })
        }
        if (signal.aborted) break
        await sleep(this.settings.cooldownMs + 200)
        continue
      }
      if (signal.aborted) break
      const forced = this.#forceRequested
      this.#forceRequested = false
      if (segment) {
        this.#record(segment)
        if (forced) {
          // 「立即回答」：这一段不看提问判定，直接送出去。
          segment.manual = true
          segment.isQuestion = true
          segment.reason = 'manual'
          let delivered = false
          try {
            delivered = (await this.#deliver(segment.text, 'question', segment, { force: true })) !== null
          } catch (error) {
            this.#fail(error)
          }
          this.#settleForce({ ok: true, delivered, text: segment.text })
        } else if (!segment.isQuestion && this.#promoteFollowUp(segment)) {
          segment.isQuestion = true
          segment.promoted = 'follow-up'
        }
        if (!forced && segment.isQuestion && this.settings.autoAnswer) {
          try {
            await this.#deliver(segment.text, 'question', segment)
          } catch (error) {
            this.#fail(error)
          }
        } else if (!forced && !segment.isQuestion) {
          segment.reason = 'not-a-question'
        }
      } else if (forced) {
        this.#settleForce({ ok: true, delivered: false, text: '', reason: 'nothing-heard' })
      }
      await sleep(this.settings.cooldownMs)
    }
    // 循环退出（stop() / abort）时结算掉还挂着的「立即回答」。
    this.#settleForce({ ok: false, delivered: false, text: '', reason: 'stopped' })
  }

  #record(segment) {
    this.lastText = segment.text
    this.segments.push(segment)
    const overflow = this.segments.length - this.settings.maxSegments
    if (overflow > 0) this.segments.splice(0, overflow)
  }

  /**
   * 高灵敏度（high）下的追问兜底：紧跟在提问后面的短句，即使没有疑问线索也当成追问
   * ——「具体一点」「那后来呢」常被采集器切成独立一段而丢掉。
   *
   * 只认「上一段是提问」这一步，且上一段本身不能是被兜底捞上来的（避免一句话之后
   * 把整段闲聊都当追问），并且只在 questionSensitivity === 'high' 时生效。
   *
   * @param {object} segment 已 record 进 this.segments 的当前段
   * @returns {boolean}
   */
  #promoteFollowUp(segment) {
    if (this.settings.questionSensitivity !== 'high') return false
    const length = normalizeText(segment.text).length
    if (length < 2 || length > 20) return false
    const previous = this.segments[this.segments.length - 2]
    if (!previous || previous.promoted !== undefined) return false
    if (segment.t - previous.t > FOLLOWUP_WINDOW_MS) return false
    return previous.isQuestion === true
  }

  async #captureSegment(signal) {
    const seconds = Math.min(
      MAX_CAPTURE_SECONDS,
      Math.max(MIN_CAPTURE_SECONDS, Math.round(this.settings.maxSegmentMs / 1000) + 2),
    )
    const session = await this.#capture.startCaptureAuto({
      seconds,
      deviceId: this.settings.deviceId !== '' ? this.settings.deviceId : undefined,
      levels: true,
      silenceStopMs: this.settings.silenceMs,
    })
    this.#session = session
    this.#captureStartedAt = Date.now()
    await this.#waitForSegment(session, signal, (seconds + 10) * 1000)
    if (this.#session === session) this.#session = null
    this.#captureStartedAt = 0
    if (signal.aborted || this.state !== 'listening') {
      try {
        session.kill()
      } catch {
        /* already gone */
      }
      return null
    }
    try {
      await session.stop()
    } catch {
      /* the recorder may already have exited after the silence stop */
    }
    const capture = await this.#capture.finishCapture(session, { keep: true })
    const levels = Array.isArray(session.levels) ? session.levels : []
    const peak = Math.max(
      Number(capture?.peak) || 0,
      ...levels.map((level) => Number(level?.rms) || 0),
    )
    const duration = Number(capture?.seconds) || 0
    // 「立即回答」是用户按下的动作：这一段不再受 minSpeechMs 约束（只挡明显误触的
    // 超短音频），也不再要求 peak 达标——否则「正在转写时按热键」会被静音判掉。
    const forced = this.#forceRequested
    const minSeconds = forced ? FORCE_MIN_AUDIO_SECONDS : this.settings.minSpeechMs / 1000
    if (duration < minSeconds || (!forced && peak < this.settings.minPeakRms)) {
      this.#discard(capture)
      return null
    }
    try {
      const audio = await this.#capture.captureWaveBytes(capture)
      const service = this.#speechService()
      if (!service) throw new Error('当前组合里没有 speechToText 服务（请确认语音输入 bundle 已装）')
      await this.#speech.ensureReady(service, undefined, undefined, this.#speech.DEFAULT_WAIT_MS)
      // 语言提示：'auto' / '' 交给 provider 自己的语种识别（SenseVoice 支持自动
      // 识别中/英/日/韩/粤），显式 'zh'/'en' 才强行指定；英文句子在自动模式下会
      // 再以 'en' 重转一次兜底（见 #retryInEnglish）。
      const language = this.#languageHint()
      let transcript
      this.#transcribing = true
      try {
        transcript = await this.#speech.transcribeWav(service, audio, { language })
        transcript = await this.#retryInEnglish(service, audio, transcript, language)
      } finally {
        this.#transcribing = false
      }
      const text = String(transcript?.text ?? '').trim()
      if (text === '') return null
      return {
        id: randomUUID(),
        t: Date.now(),
        text,
        audioSeconds: Number(transcript?.audioSeconds) > 0 ? Number(transcript.audioSeconds) : duration,
        inferenceSeconds: Number(transcript?.inferenceSeconds) || 0,
        seconds: duration,
        rms: Number(capture?.rms) || 0,
        peak,
        isQuestion: looksLikeQuestion(text, this.settings.questionSensitivity),
        lang: language || detectLanguage(text),
        delivered: false,
        reason: '',
      }
    } finally {
      this.#discard(capture)
    }
  }

  /**
   * 转写语言提示。'auto' / '' 返回空串 = 不指定语言，交给 provider 的语种识别；
   * 显式 'zh' / 'en' 等直接采用。
   *
   * @returns {string}
   */
  #languageHint() {
    const value = String(this.settings.language ?? '').trim().toLowerCase()
    if (value === '' || value === 'auto') return ''
    return value
  }

  /**
   * 英文兜底：自动模式下第一遍转写出来的文本明显是英文时，再以 'en' 为提示重转
   * 一次（每段最多一次），避免中文提示把英文句子带成汉字/拼音；两次结果取拉丁
   * 字母更多的那个。显式指定语言时不重转。
   *
   * @param {object} service speechToText 服务
   * @param {Uint8Array} audio 这段的 WAV
   * @param {object} transcript 第一次转写结果
   * @param {string} language 本次使用的语言提示（空串 = 自动）
   * @returns {Promise<object>}
   */
  async #retryInEnglish(service, audio, transcript, language) {
    if (language !== '') return transcript
    const text = String(transcript?.text ?? '').trim()
    if (text === '' || detectLanguage(text) !== 'en') return transcript
    try {
      const again = await this.#speech.transcribeWav(service, audio, { language: 'en' })
      const english = String(again?.text ?? '').trim()
      if (english === '') return transcript
      return countLatin(english) >= countLatin(text) ? again : transcript
    } catch (error) {
      this.#log(`英文重转失败，沿用第一次结果：${error instanceof Error ? error.message : String(error)}`)
      return transcript
    }
  }

  async #waitForSegment(session, signal, timeoutMs) {
    let done = false
    const settled = session?.settled
    if (settled && typeof settled.then === 'function') {
      settled.then(() => { done = true }, () => { done = true })
    }
    const deadline = Date.now() + timeoutMs
    while (!done && !signal.aborted && this.state === 'listening' && Date.now() < deadline) {
      try {
        const level = typeof session.lastLevel === 'function' ? session.lastLevel() : null
        if (level && typeof level.rms === 'number') {
          this.level = { t: Number(level.t) || 0, rms: level.rms, db: Number.isFinite(level.db) ? level.db : decibels(level.rms) }
        }
      } catch {
        /* a level read failure must never end the segment */
      }
      await sleep(LEVEL_TICK_MS)
    }
    return done
  }

  async #deliver(text, kind, segment = null, options = {}) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('投递内容为空')
    // options.force：用户按「立即回答」明确要求答这一段 —— 跳过「像不像提问」与
    // 「够不够长」两道闸（去重仍然保留，避免同一句话被连按两次重复投递）。
    const force = options?.force === true
    if (kind === 'question') {
      const normalized = normalizeText(body)
      if (!force && normalized.length < this.settings.minQuestionChars) {
        if (segment) segment.reason = 'too-short'
        return null
      }
      const last = this.lastDelivery
      if (last && Date.now() - last.at <= this.settings.dupWindowMs
        && similarity(last.key, normalized) >= this.settings.dupSimilarity) {
        if (segment) segment.reason = 'duplicate'
        this.dropped += 1
        return null
      }
    }
    const controller = this.#sessionController()
    if (!controller || typeof controller.prompt !== 'function') {
      throw new Error('当前组合里没有 sessionController 服务，无法把提问交给会话 Agent')
    }
    // 宿主服务（sessionController.prompt / list / cancel）的第二个参数是 AbortSignal，内部会调用
    // signal.throwIfAborted()：不传就会抛 "Cannot read properties of undefined (reading 'throwIfAborted')"。
    // 监听中复用本次监听的 signal（停止监听即取消投递），热键补答时用一个一次性 signal。
    const signal = this.#signal?.signal ?? new AbortController().signal
    // 面板「选择对话」选中的会话优先；没选（''）就跟随当前会话，再退化成最近活动的会话。
    const pinned = typeof this.settings.targetSessionId === 'string' ? this.settings.targetSessionId : ''
    let sessionId = pinned !== '' ? pinned : this.sessionId
    let running = false
    let pinnedMissing = false
    try {
      const list = await controller.list(undefined, signal)
      const items = normalizeList(list)
      if (pinned !== '' && items.length > 0) {
        pinnedMissing = !items.some((item) => item?.sessionId === pinned)
      }
      const resolved = pickSessionId(list, sessionId)
      if (resolved !== '') sessionId = resolved
      running = isSessionRunning(list, sessionId)
    } catch (error) {
      this.#log(`读取会话列表失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (pinnedMissing) {
      // 固定投递的会话没了（被删/换工作区）：宁可报错也不要把提问投到别的对话里。
      if (segment) segment.reason = 'no-session'
      this.#fail(new Error(`选定的对话已不存在：${pinned}，请在面板里重新选择`))
      return null
    }
    if (sessionId === '') throw new Error('没有可投递的会话：请先在界面里打开一个会话')
    let mode = 'queue'
    if (running) {
      this.#queuedWhileBusy += 1
      if (this.#queuedWhileBusy > 2) {
        if (segment) segment.reason = 'backlog'
        this.dropped += 1
        return null
      }
      if (this.settings.interruptWhenBusy) {
        try {
          await controller.cancel({ sessionId }, signal)
        } catch {
          /* cancelling is best effort; steering still queues behind the current turn */
        }
        mode = 'steer'
      }
    } else {
      this.#queuedWhileBusy = 0
    }
    const base = kind === 'followup' ? formatFollowUp(body) : kind === 'long' ? formatLongAnswer(body) : formatQuestion(body)
    // 知识库资料内联进消息正文：回答约束要求不调用工具，所以资料必须随消息一起
    // 送到会话里（只给路径的话 Agent 没法读）。
    const knowledge = this.knowledge().block
    const payload = typeof knowledge === 'string' && knowledge !== ''
      ? `${base}\n\n${knowledge}`
      : base
    const request = {
      requestId: randomUUID(),
      sessionId,
      mode,
      content: [{ type: 'text', text: payload }],
    }
    let value
    try {
      value = await controller.prompt(request, signal)
    } catch (error) {
      // 停止监听会 abort() 这个 signal，会话服务随即以 AbortError 拒绝本次投递：
      // 这是「用户按了停止」的正常结果，静默作废，不记为错误。
      if (signal.aborted) return null
      throw error
    }
    if (value && value.accepted === false) {
      throw new Error(`会话拒绝了这次投递：${JSON.stringify(value)}`)
    }
    this.delivered += 1
    this.sessionId = sessionId
    this.lastDelivery = { key: normalizeText(body), at: Date.now(), text: body, kind }
    if (segment) {
      segment.delivered = true
      segment.reason = kind === 'followup' ? 'followup' : kind === 'long' ? 'long' : 'delivered'
    }
    return value ?? { accepted: true }
  }

  #discard(capture) {
    if (!capture) return
    try {
      if (typeof this.#capture.discardCapture === 'function' && typeof capture.path === 'string') {
        this.#capture.discardCapture(capture.path)
      }
    } catch {
      /* a leftover temp WAV is harmless */
    }
  }

  #fail(error) {
    const message = error instanceof Error ? error.message : String(error)
    this.errors.push({ at: Date.now(), message })
    if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS)
    this.#log(message)
  }
}
