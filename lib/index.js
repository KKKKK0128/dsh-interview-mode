/**
 * dsh-interview-mode — 宿主侧插件入口。
 *
 * 做三件事：
 *   1. 把「模拟面试模式」注册成 DSH 的原生 mode（agent preset），让它在新建会话的
 *      模式选择器里出现；
 *   2. 注入模式提示词段（只在收到带 [模拟面试·…] 标记的消息时生效，因此全局注入
 *      也完全无副作用）；
 *   3. 起分段引擎 + /interview/* 路由，供侧边栏面板驱动。
 *
 * 采集与转写直接复用 dsh-system-audio 已经验证过的模块（package exports 暴露了
 * ./recorder 与 ./speech），**不修改**它任何宿主代码——这样它的宿主半不用重启也
 * 不会被牵连。
 */

import { captureWaveBytes, discardCapture, finishCapture, listDevices, startCaptureAuto } from 'dsh-system-audio/recorder'
import { DEFAULT_WAIT_MS, ensureReady, speechState, transcribeWav } from 'dsh-system-audio/speech'

import { InterviewEngine } from './engine.js'
import {
  INTERVIEW_PROMPT,
  PRESET_DESCRIPTION,
  PRESET_ID,
  PRESET_NAME,
  PRESET_ORDER,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
} from './prompt.js'
import { registerRoutes } from './routes.js'

export const name = 'dsh-interview-mode'

/** 采集/转写依赖（注入给引擎，便于离线替换成假实现）。 */
const capture = { captureWaveBytes, discardCapture, finishCapture, listDevices, startCaptureAuto }
const speech = { DEFAULT_WAIT_MS, ensureReady, speechState, transcribeWav }

/** preset 注册结果——/interview/ping 会带出来，便于确认模式真的挂上了。 */
const state = { id: PRESET_ID, ok: false, error: '', registeredAt: 0 }

function log(message) {
  try {
    console.log(`[dsh-interview-mode] ${message}`)
  } catch {
    /* logging must never break the plugin */
  }
}

function registration() {
  return { ...state }
}

function registerPreset(ctx) {
  const presets = ctx.agentPresets ?? (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined)
  if (!presets || typeof presets.register !== 'function') {
    state.ok = false
    state.error = '当前组合里没有 agentPresets 服务'
    return () => {}
  }
  let dispose = null
  const ready = Promise.resolve(presets.register({
    id: PRESET_ID,
    name: PRESET_NAME,
    description: PRESET_DESCRIPTION,
    order: PRESET_ORDER,
    // 模式本身的插件行：留空——引擎已经由 profile 级安装常驻，这里再挂一次只会
    // 让路由和 preset 重复注册。模式真正的“行为”是这个模式被选中后仍然生效的
    // 系统提示词段（下面那段）。
    plugins: [],
  })).then((handle) => {
    dispose = handle
    state.ok = true
    state.error = ''
    state.registeredAt = Date.now()
    log(`已注册模式 ${PRESET_ID}（${PRESET_NAME}）`)
  }, (error) => {
    state.ok = false
    state.error = error instanceof Error ? error.message : String(error)
    log(`模式注册失败：${state.error}`)
  })
  return () => {
    void ready.then(() => (typeof dispose === 'function' ? dispose() : undefined)).catch(() => {})
  }
}

/**
 * @param {object} root 插件根上下文
 */
export function apply(root) {
  root.inject(['agentPresets'], (ctx) => {
    ctx.effect(() => registerPreset(ctx), 'interview-mode:preset')
  })

  root.inject(['systemPrompt'], (ctx) => {
    ctx.effect(() => ctx.systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: INTERVIEW_PROMPT,
    }), 'interview-mode:prompt')
  })

  root.inject(['webServer'], (ctx) => {
    const webServer = ctx.webServer ?? ctx.get('webServer')
    if (!webServer) return
    const engine = new InterviewEngine({
      capture,
      speech,
      speechService: () => ctx.get('speechToText'),
      sessionController: () => ctx.get('sessionController'),
      logger: log,
    })
    ctx.effect(() => {
      const disposeRoutes = registerRoutes(ctx, webServer, { engine, capture, speech, registration })
      return () => {
        void engine.stop()
        disposeRoutes()
      }
    }, 'interview-mode:routes')
  })
}
