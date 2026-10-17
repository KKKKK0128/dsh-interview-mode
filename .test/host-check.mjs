/**
 * dsh-interview-mode — 宿主侧冒烟测试。
 *
 * 用途：在把插件注册进 profile、重启应用**之前**，先确认
 *   1. lib/index.js 能被 node 导入（`dsh-system-audio/recorder|speech` 的解析路径没问题）；
 *   2. apply(root) 用假上下文跑一遍不会抛错，且真的挂上了 9 条 /interview 路由、
 *      一个 preset、一个系统提示词段；
 *   3. /interview/ping 与 /interview/status 在空闲状态下就能返回合法 JSON；
 *   4. 卸载（effect 的 disposer）不抛错。
 *
 * 这样就能避免「宿主半边在应用启动时抛异常 → 触发 profile 自动清理」那类事故。
 *
 *   node .test/host-check.mjs
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

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

/* ------------------------------------------------------------- fake shell */

const routes = new Map()
const sections = []
const disposers = []
let presetDefinition = null
let presetDisposed = false

const webServer = {
  register(route) {
    const key = `${route.kind} ${route.path}`
    assert(!routes.has(key), `duplicate route ${key}`)
    routes.set(key, route)
    return () => routes.delete(key)
  },
}

const services = {
  speechToText: { listProviders: () => [] },
  sessionController: {
    list: async () => [{ sessionId: 's-1', updatedAt: 1, running: false, blank: false }],
    prompt: async () => ({ accepted: true }),
  },
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get: (name) => services[name],
  webServer,
  agentPresets: {
    register: async (definition) => {
      presetDefinition = definition
      return async () => { presetDisposed = true }
    },
  },
  systemPrompt: {
    section: (section) => {
      sections.push(section)
      return () => {}
    },
  },
}

const root = { inject: (_names, callback) => callback(ctx) }

/* --------------------------------------------------------------- helpers */

function makeResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(body) {
      this.body = body === undefined ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
    },
  }
  return response
}

async function callRoute(method, path, body) {
  const route = routes.get(`exact ${path.split('?')[0]}`)
  assert(route !== undefined, `route not registered: ${path}`)
  const response = makeResponse()
  const request = {
    method,
    url: path,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
    on() { return this },
    once() { return this },
    removeListener() { return this },
  }
  // 路由包装器是「发了不等」的异步 IIFE，必须等响应真正写完。
  void route.handler(request, response)
  const deadline = Date.now() + 3000
  while (response.body === null && Date.now() < deadline) await sleep(10)
  assert(response.body !== null, `no response written for ${method} ${path}`)
  let parsed = null
  try {
    parsed = response.body ? JSON.parse(response.body) : null
  } catch {
    parsed = null
  }
  return { response, json: parsed }
}

/* ----------------------------------------------------------------- tests */

console.log('宿主半加载与注册')
check('lib/index.js 可导入且导出 apply/name', () => {
  assert.equal(typeof apply, 'function')
})

apply(root)
await sleep(20)

check('挂上了全部 /interview/* 路由', () => {
  const paths = [...routes.keys()].filter((key) => key.startsWith('exact /interview/')).map((key) => key.slice(6))
  const expected = ['/interview/ping', '/interview/status', '/interview/sessions', '/interview/devices', '/interview/knowledge', '/interview/start', '/interview/stop', '/interview/answer-last', '/interview/config']
  for (const path of expected) assert(paths.includes(path), `missing route ${path}（已注册：${paths.join(', ')}）`)
})

check('注册了“模拟面试模式” preset', () => {
  assert(presetDefinition !== null, 'preset 没有被注册')
  assert.equal(presetDefinition.id, 'mock-interview')
  assert.equal(presetDefinition.name, '模拟面试模式')
  assert(Array.isArray(presetDefinition.plugins), 'plugins 必须是数组')
  assert.equal(presetDefinition.plugins.length, 0, '模式自身的插件行必须为空（引擎由 profile 常驻）')
})

check('注入了模式提示词段', () => {
  assert.equal(sections.length, 1, `expected one prompt section, got ${sections.length}`)
  assert.equal(sections[0].name, 'interview-mode')
  assert.equal(typeof sections[0].order, 'number')
  assert(typeof sections[0].text === 'string' && sections[0].text.length > 100, '提示词段文本过短')
  assert(sections[0].text.includes('模拟面试'), '提示词段里应当有模式名')
})

console.log('路由行为（空闲态）')
{
  const ping = await callRoute('GET', '/interview/ping')
  check('GET /interview/ping → ok:true', () => {
    assert.equal(ping.response.statusCode, 200, `status ${ping.response.statusCode}: ${ping.response.body}`)
    assert.equal(ping.json?.ok, true)
    assert.equal(ping.json?.prefix, '/interview')
    assert.equal(ping.json?.engine, 'idle')
    assert.equal(ping.json?.preset?.id, 'mock-interview')
  })

  const status = await callRoute('GET', '/interview/status')
  check('GET /interview/status → idle 快照', () => {
    assert.equal(status.response.statusCode, 200, `status ${status.response.statusCode}: ${status.response.body}`)
    assert.equal(status.json?.ok, true)
    assert.equal(status.json?.state, 'idle')
    assert.deepEqual(status.json?.segments, [])
    assert.equal(typeof status.json?.settings?.silenceMs, 'number')
    assert.equal(status.json?.settings?.hotkey, 'Ctrl+Shift+I')
  })

  const config = await callRoute('POST', '/interview/config', { autoAnswer: false, silenceMs: 5000 })
  check('POST /interview/config → 回读设置', () => {
    assert.equal(config.response.statusCode, 200, `status ${config.response.statusCode}: ${config.response.body}`)
    assert.equal(config.json?.ok, true)
    assert.equal(config.json?.settings?.autoAnswer, false)
    assert.equal(config.json?.settings?.silenceMs, 5000)
  })

  const sessions = await callRoute('GET', '/interview/sessions')
  check('GET /interview/sessions → 可选对话列表（含 current/target 标记）', () => {
    assert.equal(sessions.response.statusCode, 200, `status ${sessions.response.statusCode}: ${sessions.response.body}`)
    assert.equal(sessions.json?.ok, true)
    assert.equal(sessions.json?.error, '')
    assert.ok(Array.isArray(sessions.json?.items), 'items 必须是数组')
    assert.equal(sessions.json?.items?.[0]?.sessionId, 's-1')
    assert.equal(sessions.json?.items?.[0]?.title, '')
    assert.equal(sessions.json?.target, '')
  })

  const knowledge = await callRoute('GET', `/interview/knowledge?path=${encodeURIComponent(FIXTURES)}`)
  check('GET /interview/knowledge → 只回摘要与文件清单，不回内联正文', () => {
    assert.equal(knowledge.response.statusCode, 200, `status ${knowledge.response.statusCode}: ${knowledge.response.body}`)
    assert.equal(knowledge.json?.ok, true)
    assert.equal(knowledge.json?.kind, 'dir')
    assert.equal(knowledge.json?.included, 1)
    assert.equal(knowledge.json?.totalFiles, 1)
    assert.equal(knowledge.json?.block, undefined, 'block 不应下发')
    assert.ok(knowledge.json?.blockChars > 0, 'blockChars 应大于 0')
    assert.equal(knowledge.json?.files?.[0]?.rel, 'kb.md')
  })

  const stop = await callRoute('POST', '/interview/stop')
  check('空闲态 POST /interview/stop 幂等返回 idle', () => {
    assert.equal(stop.response.statusCode, 200, `status ${stop.response.statusCode}: ${stop.response.body}`)
    assert.equal(stop.json?.ok, true)
    assert.equal(stop.json?.state, 'idle')
  })
}

console.log('卸载')
check('disposer 全部可执行且不抛错', async () => {
  for (const dispose of disposers) dispose()
  await sleep(10)
  assert.equal(routes.size, 0, `路由没有被清理：${[...routes.keys()].join(', ')}`)
})

check('preset disposer 最终被调用', async () => {
  await sleep(20)
  assert.equal(presetDisposed, true, 'preset 的 disposer 没有被调用')
})

console.log(`\n${failed === 0 ? 'ALL HOST CHECKS PASSED' : 'HOST CHECKS FAILED'}  (passed ${passed}, failed ${failed})`)
process.exit(failed === 0 ? 0 : 1)
