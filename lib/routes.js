/**
 * dsh-interview-mode — 给侧边栏面板用的 HTTP 路由（全部在 /interview 下）。
 *
 *   GET  /ping          → 存活 + 引擎状态 + preset 注册结果
 *   GET  /status        → 监听状态 / 电平 / 片段列表 / 配置
 *   GET  /devices       → 输出设备 + 语音服务就绪状态
 *   GET  /sessions      → 选择对话用的会话清单（current / target / items）
 *   GET  /knowledge     → 知识库预览：?path= 指定路径（缺省用当前配置），
 *                         ?refresh=1 跳过缓存；返回文件清单与内联统计（不含正文）
 *   POST /start         → {sessionId?, deviceId?} 开始监听
 *   POST /stop          → 停止监听
 *   POST /answer-last   → 热键补答：把最近听到的内容再投一次
 *   POST /answer-now    → 立即回答：结束当前正在采集的这一段并立刻投递
 *                         （不等静音、不做提问判定；没在监听时退化成 answer-last）
 *   POST /answer-long   → 长回答：{text?} 指定片段（缺省＝最近缓冲区）要求细节
 *                         描述型的长版本（约 5 分钟口读），也不做提问判定与去重
 *   POST /config        → 合并配置补丁
 *
 * 采集与转写仍归 dsh-system-audio（它自己的 /system-audio/* 路由不动），这里只管
 * 「模式」这一层：状态、判定、投递。
 */

export const WEB_PREFIX = '/interview'

const MAX_BODY_BYTES = 64 * 1024

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

function pick(params, body, key) {
  const fromBody = body?.[key]
  if (fromBody !== undefined && fromBody !== null && fromBody !== '') return fromBody
  const fromQuery = params.get(key)
  return fromQuery === null || fromQuery === '' ? undefined : fromQuery
}

/**
 * 注册 /interview/* 路由。
 *
 * @param {object} ctx 宿主插件上下文（用来取 speechToText）
 * @param {object} webServer webServer 服务
 * @param {{ engine: object, speech: object, capture: object, registration: () => object }} deps
 * @returns {() => void} 卸载函数
 */
export function registerRoutes(ctx, webServer, deps) {
  const { engine, speech, capture, registration } = deps

  const speechService = () => {
    try {
      return ctx.get('speechToText')
    } catch {
      return undefined
    }
  }

  const handlePing = (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      prefix: WEB_PREFIX,
      engine: engine.state,
      sessionId: engine.sessionId,
      preset: registration(),
    })
  }

  const handleStatus = (_req, res) => {
    sendJson(res, 200, { ...engine.status(), preset: registration() })
  }

  const handleDevices = async (_req, res) => {
    try {
      const devices = await capture.listDevices()
      const service = speechService()
      const state = service
        ? { available: true, ...speech.speechState(service) }
        : { available: false, providerId: '', phase: 'unavailable', language: '', languages: [] }
      sendJson(res, 200, {
        ok: true,
        default: devices.default,
        devices: devices.devices,
        speech: state,
        selected: engine.settings.deviceId,
      })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  const handleStart = async (_req, res, params, body) => {
    try {
      const sessionId = pick(params, body, 'sessionId')
      const deviceId = pick(params, body, 'deviceId')
      const settings = {}
      if (body?.silenceMs !== undefined) settings.silenceMs = body.silenceMs
      if (body?.autoAnswer !== undefined) settings.autoAnswer = body.autoAnswer
      if (Object.keys(settings).length > 0) engine.configure(settings)
      const status = await engine.start({
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        deviceId: typeof deviceId === 'string' ? deviceId : undefined,
      })
      sendJson(res, 200, { ...status, ok: true })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  const handleStop = async (_req, res) => {
    try {
      const status = await engine.stop()
      sendJson(res, 200, { ...status, ok: true })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  const handleAnswerLast = async (_req, res) => {
    try {
      const result = await engine.answerLast()
      sendJson(res, 200, { ...result, sessionId: engine.sessionId })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 立即回答：把正在采集的这一段立刻收尾并投递出去。面板按钮 / Ctrl+Shift+U 用它，
   * 用来对付「面试官说完停在那里、静音判定还没到」以及「已经听到但还没转写完」。
   */
  const handleAnswerNow = async (_req, res, _params, body) => {
    try {
      if (body && typeof body.sessionId === 'string' && body.sessionId !== '') engine.sessionId = body.sessionId
      const result = await engine.answerNow()
      sendJson(res, 200, { ...result, sessionId: engine.sessionId })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 长回答：把某条转写片段（body.text，省略则取最近缓冲区）重投一次，要求
   * 细节描述型的长版本（约 5 分钟口读）。面板的「长回答」按钮挨着「补答」。
   */
  const handleAnswerLong = async (_req, res, _params, body) => {
    try {
      if (body && typeof body.sessionId === 'string' && body.sessionId !== '') engine.sessionId = body.sessionId
      const text = body && typeof body.text === 'string' ? body.text : ''
      const result = await engine.answerLong(text)
      sendJson(res, 200, { ...result, sessionId: engine.sessionId })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  const handleSessions = async (_req, res) => {
    sendJson(res, 200, await engine.listSessions())
  }

  const handleConfig = async (_req, res, params, body) => {
    try {
      void params
      const settings = engine.configure(body ?? {})
      sendJson(res, 200, { ok: true, settings })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 知识库预览：面板选好路径后拿它显示「已内联 N/M 个文件」，也给测试用来
   * 核对抽取结果。故意不返回内联正文（block），那可能有好几十 KB。
   */
  const handleKnowledge = (_req, res, params) => {
    try {
      const path = params.get('path')
      const target = path === null || path === '' ? undefined : path
      const result = engine.knowledge(target, params.get('refresh') === '1')
      const files = Array.isArray(result.files) ? result.files : []
      const { block, files: _files, ...info } = result
      sendJson(res, 200, {
        ok: true,
        ...info,
        blockChars: typeof block === 'string' ? block.length : 0,
        files: files.slice(0, 200),
      })
    } catch (error) {
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  const routes = [
    ['/ping', handlePing],
    ['/status', handleStatus],
    ['/devices', handleDevices],
    ['/sessions', handleSessions],
    ['/knowledge', handleKnowledge],
    ['/start', handleStart],
    ['/stop', handleStop],
    ['/answer-last', handleAnswerLast],
    ['/answer-now', handleAnswerNow],
    ['/answer-long', handleAnswerLong],
    ['/config', handleConfig],
  ]

  const disposers = routes.map(([path, handler]) => webServer.register({
    kind: 'exact',
    path: WEB_PREFIX + path,
    handler: (req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const body = await readJson(req).catch(() => ({}))
        await handler(req, res, url.searchParams, body)
      })().catch((error) => {
        if (!res.headersSent) fail(res, 500, error instanceof Error ? error.message : String(error))
      })
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
