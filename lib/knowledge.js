/**
 * dsh-interview-mode — 「知识库」资料读取。
 *
 * 面板里选定的一个文件夹或文件，会在每次投递提问时被**内联**进消息正文：
 * 因为「模拟面试模式」的回答约束要求不调用工具（来不及），所以资料必须随消息
 * 一起送到会话里，而不能只给一个路径让 Agent 自己去读。
 *
 * 支持：
 *   - 纯文本类文件（.md/.txt/.json/.csv/源码…）直接读；
 *   - .docx 用内置的最小 zip 读取器抽出 word/document.xml 的正文（不需要额外依赖）；
 *   - 其它格式（.pdf/.png…）只在末尾列出文件名，不内联。
 *
 * 体积预算：单文件 8 KB / 合计 24 KB / 最多 40 个文件，超出部分在消息里注明。
 * 本文件只依赖 node:fs / node:path / node:zlib，不依赖 DSH，便于离线测试。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** 投递消息里知识库段的标记（提示词里按这个标记约定回答优先级）。 */
export const KNOWLEDGE_TAG = '[知识库]'

/** 面板最多保存多少条候选路径。 */
export const MAX_KNOWLEDGE_PATHS = 20
/** 单条路径最大字符数。 */
export const MAX_KNOWLEDGE_PATH_CHARS = 512

/** 默认体积预算（可用 options 覆盖，测试里会调小）。 */
export const KNOWLEDGE_LIMITS = {
  maxFiles: 40,
  maxDepth: 2,
  maxScan: 400,
  // 纯文本按原始字节量限流；.docx 是压缩包，原始体积大但正文往往很小，
  // 所以它只受 maxRawBytes 的粗筛，真正的上限是抽取后正文的 maxFileBytes。
  maxFileBytes: 8 * 1024,
  maxRawBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024,
}

/** 可内联的纯文本扩展名。 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.rst', '.org',
  '.json', '.jsonl', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.csv', '.tsv', '.sql',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.ps1', '.psm1', '.sh', '.bat', '.cmd',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.kt', '.go', '.rs', '.rb', '.php',
  '.v', '.sv', '.svh', '.vhdl', '.vhd', '.m', '.mm', '.r', '.jl', '.lua',
  '.html', '.htm', '.css', '.scss', '.xml', '.tex',
])

/** 遍历时跳过的目录名。 */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  'dist', 'build', 'out', '.next', '.cache', '.idea', '.vscode', 'target',
])

/**
 * 规范化一条知识库路径：去空白、去首尾引号、截断超长。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeKnowledgePath(value) {
  if (value === null || value === undefined) return ''
  const raw = String(value).trim().replace(/^["']+/, '').replace(/["']+$/, '').trim()
  if (raw === '') return ''
  return raw.length > MAX_KNOWLEDGE_PATH_CHARS ? raw.slice(0, MAX_KNOWLEDGE_PATH_CHARS) : raw
}

/**
 * 规范化候选路径列表：去重（不区分大小写，Windows 语义）、保序、限量。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeKnowledgeList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    const path = normalizeKnowledgePath(item)
    if (path === '') continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
    if (out.length >= MAX_KNOWLEDGE_PATHS) break
  }
  return out
}

/* ------------------------------------------------------------- zip / docx */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * 从一个 zip（.docx 就是 zip）里取出指定条目并解压。找不到就返回 null。
 * 只支持 store(0) 与 deflate(8) 两种方式 —— Office 文档用的就是这两种。
 *
 * @param {Buffer} buffer
 * @param {string} wanted 条目名，如 'word/document.xml'
 * @returns {Buffer|null}
 */
function readZipEntry(buffer, wanted) {
  let eocd = -1
  const floor = Math.max(0, buffer.length - 66000)
  for (let index = buffer.length - 22; index >= floor; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index
      break
    }
  }
  if (eocd < 0) return null
  const count = buffer.readUInt16LE(eocd + 10)
  let pointer = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) return null
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    if (name === wanted) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return null
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const data = buffer.subarray(start, start + compressedSize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data)
      return null
    }
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return null
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
    }
    const known = XML_ENTITIES[body]
    return known === undefined ? match : known
  })
}

/**
 * 把 .docx 的正文抽成纯文本（按段落换行）。读不出来返回 ''。
 *
 * @param {string} file
 * @returns {string}
 */
export function docxToText(file) {
  const document = readZipEntry(readFileSync(file), 'word/document.xml')
  if (!document) return ''
  const xml = document.toString('utf8')
  const lines = []
  for (const paragraph of xml.split(/<\/w:p>/)) {
    let line = ''
    const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
    let match = pattern.exec(paragraph)
    while (match !== null) {
      line += match[1]
      match = pattern.exec(paragraph)
    }
    const text = decodeXml(line).trim()
    if (text !== '') lines.push(text)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ 收集 */

function walkDirectory(root, current, depth, limits, entries, state) {
  let items
  try {
    items = readdirSync(current, { withFileTypes: true })
  } catch (error) {
    if (state.error === '') state.error = error instanceof Error ? error.message : String(error)
    return
  }
  for (const item of items) {
    if (entries.length >= limits.maxScan) {
      state.truncatedScan = true
      return
    }
    if (item.name.startsWith('.')) continue
    const absolute = join(current, item.name)
    const rel = current === root ? item.name : join(current.slice(root.length + 1), item.name)
    if (item.isDirectory()) {
      if (depth >= limits.maxDepth) continue
      if (SKIP_DIRECTORIES.has(item.name.toLowerCase())) continue
      walkDirectory(root, absolute, depth + 1, limits, entries, state)
      continue
    }
    if (!item.isFile()) continue
    let size = 0
    try {
      size = statSync(absolute).size
    } catch {
      continue
    }
    entries.push({ abs: absolute, rel: rel.split(sep).join('/'), bytes: size })
  }
}

/**
 * 读取知识库资料并组装成可直接拼进投递消息的文本块。
 *
 * @param {unknown} basePath 文件或文件夹路径（'' = 不使用知识库）
 * @param {Partial<typeof KNOWLEDGE_LIMITS>} [options]
 * @returns {{
 *   path: string, kind: 'empty'|'missing'|'file'|'dir'|'other',
 *   error: string, files: object[], totalFiles: number, included: number,
 *   bytes: number, truncated: boolean, block: string,
 * }}
 */
export function collectKnowledge(basePath, options = {}) {
  const limits = { ...KNOWLEDGE_LIMITS, ...options }
  const path = normalizeKnowledgePath(basePath)
  const out = {
    path,
    kind: 'empty',
    error: '',
    files: [],
    totalFiles: 0,
    included: 0,
    bytes: 0,
    truncated: false,
    block: '',
  }
  if (path === '') return out
  let info
  try {
    info = statSync(path)
  } catch (error) {
    out.kind = 'missing'
    out.error = error instanceof Error ? error.message : String(error)
    return out
  }
  const entries = []
  const state = { error: '', truncatedScan: false }
  if (info.isDirectory()) {
    out.kind = 'dir'
    walkDirectory(path, path, 0, limits, entries, state)
  } else if (info.isFile()) {
    out.kind = 'file'
    entries.push({ abs: path, rel: basename(path), bytes: info.size })
  } else {
    out.kind = 'other'
    out.error = '既不是文件也不是文件夹'
    return out
  }
  out.error = state.error
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  const picked = []
  let total = 0
  // 两遍：先把可读的候选都抽成正文（这一步只判格式、原始体积、空文件），
  // 再按正文字节数从小到大装预算——小文件优先，同样的 24 KB 能装下更多份资料，
  // 避免一份几百 KB 的表单把预算吃光、把正文大的资料挤出去。同尺寸按 rel 字典序保证可复现。
  const order = entries.slice().sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const viable = []
  for (const entry of order) {
    entry.included = false
    entry.reason = ''
    const extension = extname(entry.rel).toLowerCase()
    const isDocx = extension === '.docx'
    if (!isDocx && !TEXT_EXTENSIONS.has(extension)) {
      entry.reason = 'unsupported'
      continue
    }
    const rawLimit = isDocx ? limits.maxRawBytes : limits.maxFileBytes
    if (entry.bytes > rawLimit) {
      entry.reason = 'too-large'
      continue
    }
    let text = ''
    try {
      text = isDocx ? docxToText(entry.abs) : readFileSync(entry.abs, 'utf8')
    } catch {
      entry.reason = 'read-failed'
      continue
    }
    text = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n').trim()
    if (text === '') {
      entry.reason = 'empty'
      continue
    }
    let size = Buffer.byteLength(text, 'utf8')
    entry.clipped = false
    if (size > limits.maxFileBytes) {
      text = `${text.slice(0, limits.maxFileBytes)}\n…（本文件已截断）`
      size = Buffer.byteLength(text, 'utf8')
      entry.clipped = true
    }
    entry.text = text
    entry.textSize = size
    entry.isDocx = isDocx
    viable.push(entry)
  }
  viable.sort((a, b) => (a.textSize - b.textSize) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const entry of viable) {
    if (picked.length >= limits.maxFiles) {
      entry.reason = 'over-count'
      continue
    }
    if (total + entry.textSize > limits.maxTotalBytes) {
      entry.reason = 'budget'
      continue
    }
    entry.included = true
    entry.reason = entry.isDocx ? 'docx' : 'text'
    if (entry.clipped) out.truncated = true
    total += entry.textSize
    picked.push(entry)
  }
  picked.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  out.files = entries.map((entry) => ({
    rel: entry.rel,
    bytes: entry.bytes,
    included: entry.included,
    reason: entry.reason,
  }))
  out.totalFiles = entries.length
  out.included = picked.length
  out.bytes = total
  if (state.truncatedScan) out.truncated = true

  const skipped = entries.filter((entry) => entry.included !== true)
  const lines = []
  if (picked.length === 0) {
    lines.push(`${KNOWLEDGE_TAG} 已选定资料「${path}」，但其中没有可内联的文本文件（共 ${entries.length} 个文件）。请按常识作答。`)
  } else {
    const kb = (total / 1024).toFixed(1)
    lines.push(`${KNOWLEDGE_TAG} 以下是本次回答的优先依据（来源：${path}；已内联 ${picked.length}/${entries.length} 个文件，约 ${kb} KB）。请优先使用其中的事实、数字与结论作答，不要编造资料里没有的具体数据。`)
    for (const entry of picked) {
      lines.push(`--- ${entry.rel} ---`, entry.text)
    }
    if (skipped.length > 0) {
      const names = skipped.slice(0, 8).map((entry) => entry.rel).join('、')
      const more = skipped.length > 8 ? ` 等 ${skipped.length} 个` : ''
      lines.push(`（未内联：${names}${more}；原因：格式不支持或超出体积预算）`)
    }
  }
  out.block = lines.join('\n')
  return out
}
