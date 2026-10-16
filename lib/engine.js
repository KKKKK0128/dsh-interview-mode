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

import {
  DEFAULT_DUP_SIMILARITY,
  formatFollowUp,
  formatQuestion,
  looksLikeQuestion,
  normalizeText,
  similarity,
} from './prompt.js'

export const DEFAULT_SETTINGS = {
  deviceId: '',
  autoStart: false,
  autoAnswer: true,
  silenceMs: 700,
  minSpeechMs: 800,
  minPeakRms: 0.008,
  maxSegmentMs: 30000,
  cooldownMs: 300,
  dupSimilarity: DEFAULT_DUP_SIMILARITY,
  dupWindowMs: 10000,
  minQuestionChars: 6,
  maxBufferSeconds: 30,
  maxSegments: 60,
  interruptWhenBusy: false,
  language: 'auto',
  hotkey: 'Ctrl+Shift+I',
}

const REPORT_SEGMENTS = 12
const MAX_ERRORS = 20
const LEVEL_TICK_MS = 120
const MAX_CAPTURE_SECONDS = 300
const MIN_CAPTURE_SECONDS = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      deviceId: this.settings.deviceId,
      level: { ...this.level },
      lastText: this.lastText,
      delivered: this.delivered,
      dropped: this.dropped,
      startedAt: this.startedAt,
      errors: this.errors.slice(-5),
      settings: { ...this.settings },
      segments: this.segments.slice(-REPORT_SEGMENTS).reverse(),
    }
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
    if (patch.language !== undefined && patch.language !== null) next.language = String(patch.language) || 'auto'
    if (patch.hotkey !== undefined && patch.hotkey !== null) next.hotkey = String(patch.hotkey) || DEFAULT_SETTINGS.hotkey
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
    this.startedAt = Date.now()
    this.#queuedWhileBusy = 0
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
    this.level = { t: 0, rms: 0, db: -120 }
    return this.status()
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

  async #run(signal) {
    while (!signal.aborted && this.state === 'listening') {
      let segment = null
      try {
        segment = await this.#captureSegment(signal)
      } catch (error) {
        this.#fail(error)
        if (signal.aborted) break
        await sleep(this.settings.cooldownMs + 200)
        continue
      }
      if (signal.aborted) break
      if (segment) {
        this.#record(segment)
        if (segment.isQuestion && this.settings.autoAnswer) {
          try {
            await this.#deliver(segment.text, 'question', segment)
          } catch (error) {
            this.#fail(error)
          }
        } else if (!segment.isQuestion) {
          segment.reason = 'not-a-question'
        }
      }
      await sleep(this.settings.cooldownMs)
    }
  }

  #record(segment) {
    this.lastText = segment.text
    this.segments.push(segment)
    const overflow = this.segments.length - this.settings.maxSegments
    if (overflow > 0) this.segments.splice(0, overflow)
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
    await this.#waitForSegment(session, signal, (seconds + 10) * 1000)
    if (this.#session === session) this.#session = null
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
    if (duration < this.settings.minSpeechMs / 1000 || peak < this.settings.minPeakRms) {
      this.#discard(capture)
      return null
    }
    try {
      const audio = await this.#capture.captureWaveBytes(capture)
      const service = this.#speechService()
      if (!service) throw new Error('当前组合里没有 speechToText 服务（请确认语音输入 bundle 已装）')
      const ready = await this.#speech.ensureReady(service, undefined, undefined, this.#speech.DEFAULT_WAIT_MS)
      const language = this.settings.language !== '' && this.settings.language !== 'auto'
        ? this.settings.language
        : ready.language
      const transcript = await this.#speech.transcribeWav(service, audio, { language })
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
        isQuestion: looksLikeQuestion(text),
        delivered: false,
        reason: '',
      }
    } finally {
      this.#discard(capture)
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

  async #deliver(text, kind, segment = null) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('投递内容为空')
    if (kind === 'question') {
      const normalized = normalizeText(body)
      if (normalized.length < this.settings.minQuestionChars) {
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
    let sessionId = this.sessionId
    let running = false
    try {
      const list = await controller.list(undefined, signal)
      const resolved = pickSessionId(list, this.sessionId)
      if (resolved !== '') sessionId = resolved
      running = isSessionRunning(list, sessionId)
    } catch (error) {
      this.#log(`读取会话列表失败：${error instanceof Error ? error.message : String(error)}`)
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
    const payload = kind === 'followup' ? formatFollowUp(body) : formatQuestion(body)
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
      segment.reason = kind === 'followup' ? 'followup' : 'delivered'
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
