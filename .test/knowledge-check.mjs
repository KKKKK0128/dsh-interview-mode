/**
 * dsh-interview-mode 知识库离线测试。
 *
 * 覆盖 lib/knowledge.js：路径规范化、目录扫描的包含/排除规则、体积截断与预算、
 * 以及 .docx（zip 容器）的正文抽取。夹具全部在测试目录里现场生成再清理。
 *
 * 运行：node .test/knowledge-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

import {
  collectKnowledge,
  docxToText,
  KNOWLEDGE_TAG,
  MAX_KNOWLEDGE_PATH_CHARS,
  MAX_KNOWLEDGE_PATHS,
  normalizeKnowledgeList,
  normalizeKnowledgePath,
} from '../lib/knowledge.js'

let passed = 0
let failed = 0

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ----------------------------------------------------------- zip 夹具生成 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let value = -1
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ -1) >>> 0
}

/** 打一个最小 zip：默认 store(0)，第三项写 'deflate' 时用 deflate(8)。 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text, mode] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const raw = Buffer.from(text, 'utf8')
    const method = mode === 'deflate' ? 8 : 0
    const data = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    nameBuffer.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

/* --------------------------------------------------------------- 夹具目录 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(TEST_DIR, '.fixture-kb')

function buildFixture() {
  rmSync(FIXTURE, { recursive: true, force: true })
  mkdirSync(join(FIXTURE, 'nested'), { recursive: true })
  mkdirSync(join(FIXTURE, 'l1', 'l2', 'l3'), { recursive: true })
  mkdirSync(join(FIXTURE, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(FIXTURE, 'mixed'), { recursive: true })
  writeFileSync(join(FIXTURE, 'note.md'), '# 张文恺\n项目亮点：ΔSFDR +14.77 dB\n', 'utf8')
  writeFileSync(join(FIXTURE, 'data.json'), '{"enob": 11.2}', 'utf8')
  writeFileSync(join(FIXTURE, 'nested', 'level2.txt'), '第二层文本', 'utf8')
  writeFileSync(join(FIXTURE, 'l1', 'l2', 'l3', 'deep.txt'), '太深了', 'utf8')
  writeFileSync(join(FIXTURE, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1', 'utf8')
  writeFileSync(join(FIXTURE, 'big.txt'), 'A'.repeat(20000), 'utf8')
  writeFileSync(join(FIXTURE, 'empty.md'), '', 'utf8')
  writeFileSync(join(FIXTURE, 'blob.bin'), Buffer.from([0, 1, 2, 3]), 'utf8')
  writeFileSync(join(FIXTURE, '.hidden.md'), '不该被扫到', 'utf8')
  writeFileSync(join(FIXTURE, 'mixed', 'blob.bin'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(FIXTURE, 'mixed', 'empty.md'), '', 'utf8')
  writeFileSync(join(FIXTURE, 'resume.docx'), makeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['word/document.xml', '<w:document><w:body>'
      + '<w:p><w:r><w:t>张文恺 · 光电硬件实习</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t xml:space="preserve">ΔSFDR +14.77 &amp; dB</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>  </w:t></w:r></w:p>'
      + '</w:body></w:document>'],
  ]))
  // 压缩后的 .docx：磁盘体积很小，但抽出来的正文远超 maxFileBytes，
  // 用来走 collectKnowledge 里的「文本已截断」分支。
  writeFileSync(join(FIXTURE, 'verbose.docx'), makeZip([
    ['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>'
      + 'B'.repeat(4000) + '</w:t></w:r></w:p></w:body></w:document>', 'deflate'],
  ]))
}

/** 目录扫描的默认结果（供多条断言复用）。 */
const dirResult = () => collectKnowledge(FIXTURE, { maxFiles: 100, maxScan: 100 })
const fileOf = (result, rel) => result.files.find((entry) => entry.rel === rel)
const blockOf = (result, rel) => (result.block.includes(`--- ${rel} ---`) ? rel : '')
const toPosix = (value) => value.split(sep).join('/')

buildFixture()

console.log('路径规范化')
check('normalizeKnowledgePath 去空白与首尾引号', () => {
  assert.equal(normalizeKnowledgePath('  "F:\\SDU\\k"  '), 'F:\\SDU\\k')
  assert.equal(normalizeKnowledgePath("D:\\资料'"), 'D:\\资料')
  assert.equal(normalizeKnowledgePath(null), '')
  assert.equal(normalizeKnowledgePath('   '), '')
})
check('normalizeKnowledgePath 截断超长路径', () => {
  const long = 'x'.repeat(MAX_KNOWLEDGE_PATH_CHARS + 50)
  assert.equal(normalizeKnowledgePath(long).length, MAX_KNOWLEDGE_PATH_CHARS)
})
check('normalizeKnowledgeList 去重（大小写不敏感）、保序、限量', () => {
  assert.deepEqual(normalizeKnowledgeList(['C:\\A', 'c:\\a', '', '  ', 'D:\\b']), ['C:\\A', 'D:\\b'])
  assert.deepEqual(normalizeKnowledgeList('not-an-array'), [])
  const many = Array.from({ length: MAX_KNOWLEDGE_PATHS + 5 }, (_, index) => `C:\\p${index}`)
  assert.equal(normalizeKnowledgeList(many).length, MAX_KNOWLEDGE_PATHS)
})

console.log('路径状态（空 / 不存在 / 单文件）')
check('空路径返回 kind empty 且没有内联块', () => {
  const result = collectKnowledge('')
  assert.equal(result.kind, 'empty')
  assert.equal(result.block, '')
  assert.equal(result.totalFiles, 0)
})
check('不存在的路径返回 kind missing 与错误信息', () => {
  const result = collectKnowledge(join(FIXTURE, '不存在的东西'))
  assert.equal(result.kind, 'missing')
  assert.notEqual(result.error, '')
  assert.equal(result.included, 0)
})
check('单个文件路径返回 kind file，rel 是文件名', () => {
  const result = collectKnowledge(join(FIXTURE, 'note.md'))
  assert.equal(result.kind, 'file')
  assert.deepEqual(result.files.map((entry) => entry.rel), ['note.md'])
  assert.equal(result.included, 1)
  assert.ok(blockOf(result, 'note.md') !== '')
})

console.log('目录扫描的包含与排除')
check('目录返回 kind dir，根目录文本文件被内联', () => {
  const result = dirResult()
  assert.equal(result.kind, 'dir')
  assert.equal(fileOf(result, 'note.md').included, true)
  assert.equal(fileOf(result, 'note.md').reason, 'text')
  assert.ok(blockOf(result, 'note.md') !== '')
})
check('子目录文件被内联，超过 maxDepth 的目录被跳过', () => {
  const result = dirResult()
  assert.equal(fileOf(result, 'nested/level2.txt').included, true)
  assert.equal(fileOf(result, 'l1/l2/l3/deep.txt'), undefined)
})
check('node_modules 与隐藏文件不参与扫描', () => {
  const result = dirResult()
  assert.equal(fileOf(result, 'node_modules/pkg/index.js'), undefined)
  assert.equal(fileOf(result, '.hidden.md'), undefined)
})
check('超大文件标记 too-large，不占用预算', () => {
  const result = dirResult()
  const entry = fileOf(result, 'big.txt')
  assert.equal(entry.included, false)
  assert.equal(entry.reason, 'too-large')
})
check('不支持的扩展名标记 unsupported，空文件标记 empty', () => {
  const result = dirResult()
  assert.equal(fileOf(result, 'blob.bin').reason, 'unsupported')
  assert.equal(fileOf(result, 'empty.md').reason, 'empty')
})
check('.docx 走 docx 通道被内联', () => {
  const result = dirResult()
  const entry = fileOf(result, 'resume.docx')
  assert.equal(entry.included, true)
  assert.equal(entry.reason, 'docx')
})
check('rel 路径统一成 / 分隔', () => {
  const result = dirResult()
  assert.equal(toPosix(fileOf(result, 'nested/level2.txt').rel), 'nested/level2.txt')
})
check('.docx 只受 maxRawBytes 粗筛，原始体积大于 maxFileBytes 也能内联', () => {
  const result = collectKnowledge(FIXTURE, { maxFiles: 100, maxScan: 100, maxFileBytes: 64, maxRawBytes: 1024 * 1024 })
  const entry = fileOf(result, 'resume.docx')
  assert.equal(entry.included, true)
  assert.equal(entry.reason, 'docx')
})
check('.docx 超过 maxRawBytes 才标记 too-large', () => {
  const result = collectKnowledge(FIXTURE, { maxFiles: 100, maxScan: 100, maxRawBytes: 64 })
  const entry = fileOf(result, 'resume.docx')
  assert.equal(entry.included, false)
  assert.equal(entry.reason, 'too-large')
})

console.log('内联文本块结构')
check('块头带 [知识库] 标记与来源路径、统计', () => {
  const result = dirResult()
  const first = result.block.split('\n')[0]
  assert.ok(first.startsWith(KNOWLEDGE_TAG), first)
  assert.ok(first.includes(FIXTURE), first)
  assert.ok(first.includes(`${result.included}/${result.totalFiles}`), first)
})
check('每个内联文件都有 --- 相对路径 --- 分隔行', () => {
  const result = dirResult()
  assert.ok(blockOf(result, 'note.md') !== '')
  assert.ok(blockOf(result, 'resume.docx') !== '')
  assert.ok(result.block.includes('张文恺'), '内联正文应出现在块里')
})
check('未内联文件在块尾被点名', () => {
  const result = dirResult()
  assert.ok(result.block.includes('（未内联：'), '应列出未内联文件')
  assert.ok(result.block.includes('blob.bin'), result.block.split('\n').slice(-1)[0])
})
check('没有可内联文件时给出降级说明', () => {
  const result = collectKnowledge(join(FIXTURE, 'mixed'))
  assert.equal(result.included, 0)
  assert.ok(result.block.includes(KNOWLEDGE_TAG), result.block)
  assert.ok(result.block.includes('没有可内联的文本文件'), result.block)
})

console.log('体积截断与预算')
check('超过 maxFileBytes 的文本被截断并标记 truncated', () => {
  const result = collectKnowledge(FIXTURE, { maxFileBytes: 256, maxTotalBytes: 1024 * 1024 })
  const entry = fileOf(result, 'verbose.docx')
  assert.equal(entry.bytes <= 256, true, '夹具本身要足够小才会走截断分支')
  assert.equal(entry.included, true)
  assert.equal(result.truncated, true)
  assert.ok(result.block.includes('本文件已截断'), '应有截断提示')
  assert.equal(blockOf(result, 'big.txt'), '')
})
check('总预算耗尽的文件标记 budget', () => {
  const result = collectKnowledge(FIXTURE, { maxFiles: 100, maxTotalBytes: 20 })
  assert.equal(result.included, 1)
  assert.equal(fileOf(result, 'nested/level2.txt').reason, 'budget')
  assert.equal(result.bytes <= 20, true)
})
check('maxFiles 只放行前 N 个文件', () => {
  const result = collectKnowledge(FIXTURE, { maxFiles: 1, maxTotalBytes: 1024 * 1024 })
  assert.equal(result.included, 1)
  assert.ok(result.files.some((entry) => entry.reason === 'over-count'))
})
check('预算紧张时正文小的文件优先，正文大的被 budget 掉', () => {
  const result = collectKnowledge(FIXTURE, { maxFiles: 100, maxTotalBytes: 200 })
  assert.equal(fileOf(result, 'resume.docx').included, true, '正文很小的 docx 应该装得下')
  assert.equal(fileOf(result, 'verbose.docx').reason, 'budget', '正文 4000 字节的 docx 应该被预算挡掉')
  assert.equal(result.truncated, false, '被 budget 掉的截断文件不应污染 truncated 标记')
})

console.log('docx 抽取')
check('docxToText 按段落换行并解码实体与属性', () => {
  const text = docxToText(join(FIXTURE, 'resume.docx'))
  assert.equal(text, '张文恺 · 光电硬件实习\nΔSFDR +14.77 & dB')
})
check('docxToText 对非 zip 文件返回空串', () => {
  assert.equal(docxToText(join(FIXTURE, 'note.md')), '')
})
check('store 方式的 zip 之外，夹具本身确实是合法 zip', () => {
  const buffer = readFileSync(join(FIXTURE, 'resume.docx'))
  assert.equal(buffer.readUInt32LE(0), 0x04034b50)
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50)
})

// 调试时可以 KB_KEEP=1 保留夹具，方便手工核对文件与抽取结果。
if (process.env.KB_KEEP !== '1') rmSync(FIXTURE, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL KNOWLEDGE CHECKS PASSED' : 'KNOWLEDGE CHECKS FAILED'}  (passed ${passed}, failed ${failed})`)
process.exit(failed === 0 ? 0 : 1)
