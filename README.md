# dsh-interview-mode — 模拟面试模式

一个 DSH Desktop 的「模式」插件（`agentPresets` 里的 **mock-interview / 模拟面试模式**）：把电脑正在播放的声音**实时**采集下来，本地转写成文字，自动判断其中哪些话是**面试官提问**，再把提问作为聊天消息投递给**当前会话**的 Agent，让答案直接出现在对话里。

- 采集与识别复用已装的 [`dsh-system-audio`](../dsh-system-audio)（WASAPI 环回 `native/LoopbackRecorder.exe` + 本地 SenseVoice），本插件只负责**分段、判定、投递、界面**。
- 设计文档见 [`PLAN.md`](./PLAN.md)（v1.8，含取舍与被否掉的方案）。

## 安装

```powershell
# 两个仓库克隆到同一个目录下（本插件依赖 system-audio 的相对路径）
git clone https://github.com/KKKKK0128/dsh-system-audio.git
git clone https://github.com/KKKKK0128/dsh-interview-mode.git

$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "<dsh-system-audio 目录>"
& $dsh plugin --profile desktop add "<dsh-interview-mode 目录>"
```

装完重启 DSH Desktop（宿主模块按进程缓存）；只改 `lib/client.js` 不需要重启，新代码会热送到运行中的页面。

## 交互

| 动作 | 位置 |
| --- | --- |
| 开始/停止监听 | **右侧栏「模拟面试转写」标签页**的开关，或左面板设置里的同一个开关（**手动开始**，不自动开麦） |
| 强制补答最近一句 | 标签页/面板的「补答最近一句」按钮，或热键 **Ctrl+Shift+I** |
| 立即回答（不用等静音判定） | 「**立即回答**」按钮（标签页实时区 / 主面板设置里都有），或热键 **Ctrl+Shift+U**：立刻结束**正在采的这一段**并投递，不等静音切段、也不看它像不像提问（去重仍然生效）。适用于面试官说完停在那里、或这句话已经在转写但还没被判定成提问；不在监听时等价于补答最近内容 |
| 查看转写历史 | 右侧栏标签页：实时电平、最近一句、片段列表（时间 / 文本 / 是否已投递 / 补答 / 复制）。**每次开始监听都会清空上一轮的片段与计数** |
| 打开转写标签页 | 开始监听后自动打开一次；也可在右侧栏 `+` 菜单里选「模拟面试转写」 |
| 设备 / 静音阈值 / 自动回答 | 左栏「模拟面试」图标 → 主面板（**只留设置**），写 `POST /interview/config` |
| 选择投递到哪个对话 | 主面板设置里的「**选择对话**」下拉框（`targetSessionId`）。默认 `Auto` = 跟随当前打开的会话；选中某个对话后，所有提问都投到它，选中的对话被关掉时**拒绝投递并提示**，不会改投到别的会话 |
| 识别语言（中文 / 英文） | 主面板设置里的「**识别语言**」下拉框（`language`）。`auto` = 交给 SenseVoice 做语种识别，英文句子会自动再以 `en` 提示重转一次；面试全程英文时直接选 `English`，省掉这次重转。提问判定对英文线索（what / why / could you / tell me about / experience / challenge …）同样生效，英文提问会用英文回答 |
| 提问与答案 | **对话里**：提问以 `[模拟面试·面试官提问] …` 消息进入当前会话，Agent 的回答就是普通回复 |
| 选择知识库 | 主面板设置里的「**知识库**」：把资料**文件夹或文件**的完整路径粘进输入框 → 「添加」（回车也行），下拉框切换、可「移除」。宿主读取其中的文本资料（`.md/.txt/.json/代码` 等，`.docx` 现场抽正文）并**内联进每条提问消息**的 `[知识库]` 段，回答优先依据它；提示行显示「已内联 N/M 个文件 · xx KB」或错误原因 |
| 提问灵敏度 | 主面板设置里的「**提问灵敏度**」下拉框（`questionSensitivity`）：`standard`（默认）= 疑问线索 + 结尾「吗/呢/么」；`strict` = 只认疑问线索（旧行为）；`high` = 再加话题名词、请求式开头，并把紧跟提问的短句（「具体一点」）当追问兜底。漏报会丢掉面试官的问题，误报只是多答一次，**听不清就调高** |
| 长回答（细节描述型） | 「**长回答**」按钮紧挨着补答/立即回答：每一条转写片段后面（把**这一条**原文重投）以及实时区/主面板的按钮行（重投最近缓冲区）。走 `POST /interview/answer-long`，消息以 `[模拟面试·长回答请求]` 开头，要求按 **5 分钟口读**准备的细节长版本（结论 → 背景与目标 → 方案与关键细节 → 结果与收尾）；同样不看提问判定、也不去重，所以可以「先短答一遍、再点长回答展开」 |

右侧栏标签页由可选插件 [`DSH-better-sidebar`](https://www.npmjs.com/package/dsh-better-sidebar) 提供（DSH 客户端服务 `ctx.betterSidebar`）；没装它时插件自动退回「全部功能都在左面板」的旧形态，不报错。面板与标签页的内容超出高度时可**上下滚动**（转写列表另有独立滚动区，最多占 46vh，保证上方的开关始终可见）。

采集是「按静音切段」的循环：每段独立录音 → 转写 → 判定 → 投递，所以长面试不会攒成一个巨型音频。

## 默认参数

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `silenceMs` | 1000 | 静音多久算一句结束（250–10000）。面试官提问中间常有 0.5–1 秒的思考停顿，默认放宽到 1 秒，避免一句话被切成两段（被切掉的前半段往往不像提问） |
| `minSpeechMs` | 800 | 短于这个时长的段直接丢弃 |
| `minPeakRms` | 0.008 | 峰值低于此电平算静音段，丢弃（不进入缓冲、不投递） |
| `maxSegmentMs` | 30000 | 单段上限（对应录音 `seconds` 的推导） |
| `cooldownMs` | 300 | 两段之间的冷却 |
| `dupSimilarity` / `dupWindowMs` | 0.9 / 10000 | 10 秒内相似度 ≥0.9 的提问视为重复，丢弃 |
| `minQuestionChars` | 4 | 归一化后短于 4 字的段不投递（「为什么？」这类极短追问仍会被拦下） |
| `questionSensitivity` | `standard` | 提问判定灵敏度：`strict` / `standard` / `high`（见「交互」表；`high` 才会做追问兜底） |
| `autoAnswer` | true | 自动投递；关掉后只能热键补答 |
| `targetSessionId` | `''` | 投递目标对话：`''` = 跟随当前会话；非空 = 固定投到该会话 |
| `maxBufferSeconds` / `maxSegments` | 30 / 60 | 滚动缓冲，供「补答最近一句」 |
| `interruptWhenBusy` | false | Agent 忙时排队（**默认**），true 才 `cancel` 后 `steer` |
| `language` | `auto` | 识别语言：`auto` = 交给 SenseVoice 语种识别（英文段再以 `en` 重转一次兜底）；`zh` / `en` = 强行按该语言转写 |
| `knowledgeBase` | `''` | 当前选中的资料文件夹/文件，`''` = 不使用知识库；内容会内联进每条提问消息 |
| `knowledgeList` | `[]` | 面板保存过的候选路径（最多 20 条，下拉框选项） |
| `hotkey` | `Ctrl+Shift+I` / `Ctrl+Shift+U` | 页面内热键：补答最近一句 / 立即回答当前段 |

## 路由（宿主半，`webServer.register` 的 exact 路由）

```
GET  /interview/ping         → { ok, engine:'idle'|'listening', sessionId, preset:{id,ok,error,registeredAt} }
GET  /interview/status       → 状态快照：state/sessionId/level/lastText/delivered/dropped/errors/settings/inflight/segments[]（`inflight` = 正在采的这一段：`{ recording, seconds, transcribing, answering }`，空闲时为 `null`）
GET  /interview/sessions     → { ok, error, items:[{ sessionId, title, updatedAt, running, blank, current, target }], current, target }
GET  /interview/knowledge    → { ok, path, kind, error, included, totalFiles, bytes, truncated, blockChars, files:[{ rel, bytes, included, reason }] }（?path= 指定路径，缺省用当前配置；?refresh=1 跳过热缓存。**不下发内联正文**）
GET  /interview/devices      → { ok, default, devices[], speech }
POST /interview/start        → { ok, state }   body: { sessionId?, deviceId? }
POST /interview/stop         → { ok, state }
POST /interview/answer-last  → { ok, delivered, text }   热键/按钮的补答
POST /interview/answer-now   → { ok, delivered, text, reason? }   立即回答：结束当前正在采的段并立刻投递（reason: nothing-heard / timeout / stopped）
POST /interview/answer-long  → { ok, delivered, text }   body: { text?, sessionId? }  长回答：把指定片段（缺省＝最近缓冲区）按细节描述型长版本重投，不看提问判定与去重
POST /interview/config       → { ok, settings }  body: { deviceId?, autoAnswer?, silenceMs?, targetSessionId?, language?, questionSensitivity?, knowledgeBase?, knowledgeList?, hotkey?, interruptWhenBusy? }
```

投递走宿主服务 `sessionController.prompt({ requestId, sessionId, mode, content:[{type:'text',text}] }, signal)`：
- `sessionId` 面板没指定时，从 `sessionController.list()` 里挑「最近更新的非空会话」（`errors` 会记录「没有可投递的会话」）；面板指定了 `targetSessionId` 时固定用它，找不到就**拒绝投递**并在 `errors` 里报「选定的对话已不存在」（片段标 `reason:'no-session'`），不改投到别的会话。
- **第二个参数 AbortSignal 必须传**：服务内部会调用 `signal.throwIfAborted()`，漏传会以 `Cannot read properties of undefined (reading 'throwIfAborted')` 静默失败（本项目踩过，见 `.test/engine-check.mjs` 的假实现已强制校验）。

## 文件

```
lib/index.js    宿主入口：注册 preset（mock-interview）+ 3 个 agent 工具用的依赖 + /interview 路由
lib/engine.js   分段引擎（状态机、去重、忙时排队、滚动缓冲、投递）
lib/prompt.js   模式提示词 section、提问判定（CJK/英文线索 + 结尾问号）、文本归一化与相似度
lib/knowledge.js 知识库：路径规范化、目录扫描（跳过 node_modules/隐藏/超深/超大）、体积截断与总预算、.docx 正文抽取、拼装 [知识库] 内联块
lib/routes.js   11 条 exact 路由 + JSON 助手
lib/client.js   浏览器半：sidebar.panellist 图标（id interview, order 40）+ main 面板（key interview）
cordis.patch.yml / package.json   bundle 元数据（dsh.bundle.patch / dsh.client.platform）
```

依赖：`dsh-system-audio`（两个仓库请**克隆到同一父目录**，本仓库用 `node_modules` 软链引用 `dsh-system-audio/recorder` 与 `dsh-system-audio/speech`；如果两个包都已发到 npm，把 `package.json` 里的 `link:../dsh-system-audio` 换成 `^0.1.0` 即可）。

## 测试

```bash
NODE="$USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
"$NODE" .test/engine-check.mjs     # 51/51：提问判定（含英文线索、三档灵敏度）、相似度、会话选择（含固定目标会话 / 目标消失拒投）、分段引擎、忙时排队、静音段丢弃、config 夹取、英文识别（语言提示 + 自动重转）、知识库（摘要/缓存/内联进投递消息/规范化/开始监听清空记录）、提问灵敏度（三档 + 追问兜底）、立即回答（status.inflight / 提前收尾投递 / 超短音频不投 / 空闲降级）、长回答（长标记重投 / 绕过去重与长度闸 / 缺省用缓冲区 / 空缓冲报错）
"$NODE" .test/knowledge-check.mjs  # 26/26：路径规范化、目录扫描的包含与排除、体积截断与总预算（小文件优先）、.docx（现场生成的 zip）正文抽取、无资料时的降级文案
"$NODE" .test/host-check.mjs       # 16/16：11 条路由行为（含 GET /interview/knowledge、POST /interview/answer-now、POST /interview/answer-long、config 的灵敏度夹取）+ 卸载
"$NODE" .test/client-check.mjs     # 侧边栏注册 + 面板渲染 + 选择对话 + 识别语言 + 知识库下拉框 + 提问灵敏度下拉框 + 「立即回答」「长回答」按钮与 Ctrl+Shift+U 热键（含 dsh-system-audio 不再注册输入框按钮）
```

现场端到端（**需要非沙箱**：沙箱进程放出的声音进不了环回采集）：

> **端口会变**：DSH 服务端端口每次重启可能不同。下面几个脚本默认 `http://127.0.0.1:19387/interview`，对不上时传当前 GUI 地址覆盖，例如 `-Base http://127.0.0.1:55475/interview`——`live-interview.ps1` / `live-kb.ps1` / `live-sensitivity.ps1` / `live-answer-now.ps1` 都支持这个参数。

```powershell
pwsh -NoProfile -File .test/live-interview.ps1
```

知识库现场校验（自己配一个 `.test/.kb-live/bio.md` 夹具 → 设成当前知识库 → 放一段提问 → 读 `.test/.kb-live/report.json` 看 `delivered` 与投递内容里有没有 `[知识库]` 段）。脚本故意写成纯 ASCII，中文放在 UTF-8 的 `.kb-live-question.txt` 里——Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 当 ANSI 读，中文直接语法报错；本机沙箱里 SAPI 有时没有可用语音，脚本会自动退回仓库里预生成的 `question-zh.wav`：

```powershell
powershell.exe -NoProfile -File .test/live-kb.ps1
```

它会用 SAPI 合成一句「提问 + 陈述 + 提问」的中文（`.test/question-zh.wav`，已生成则复用），`POST /interview/start` 后播放，再打印 `/interview/status` 与 `/interview/stop`。

**2026-10-16 实测**：3 段全部转写正确；「请你介绍一下你在光电硬件方面最擅长的项目经验。」与「…难点在哪里呢？」判定为提问并 `delivered:true`；「后来读了硕士。」判为陈述丢弃；`errors: []`；`sessionId` 自动解析为当时的活动会话。

**英文路径（v1.4）**：`language` 三档语义与「自动模式下英文段再重转一次」由离线 battery 覆盖（见 `.test/engine-check.mjs` 的「英文识别」两段）；`lib/engine.js` 是宿主半、按进程缓存，**改完要重启 DSH Desktop** 才生效。英文识别本身用 SenseVoice 的 `en` 提示（provider 支持 zh/en/ja/ko/yue）；本机 SAPI 英文合成在沙箱里会挂起，故未做环回实测（需要非沙箱环境跑 `.test/live-interview.ps1` 的英文版）。

**知识库与记录保留（v1.5）**：知识库资料在**宿主侧**读盘（面板只看摘要），默认最多内联 40 个文件、单文件正文 8 KB、合计 24 KB；遴选分两遍——先把候选抽成正文，再按**正文从小到大**装预算（同尺寸按路径序），所以一份几百 KB 的表单不会把预算吃光、把简历挤出去。`.docx` 是压缩包，原始体积大但正文往往很小，因此只受 8 MB 的粗筛，真正的上限是抽出来的正文；`.pdf`/图片等二进制格式不内联。超出预算或条数的文件会在块尾点名。`start()` 会清空上一轮的片段、`lastText`、`delivered`/`dropped` 与 `lastDelivery`，所以每次开始监听都是干净的一轮。

**提问判定（v1.6）**：判定分成三道闸——① `looksLikeQuestion()`（问号、强疑问线索、结尾「吗/呢/么」）；② `minQuestionChars`（默认从 6 降到 4）；③ 去重与目标会话解析。灵敏度三档：`strict` 只看疑问线索（等价旧行为），`standard`（默认）加上结尾语气词，`high` 再加话题名词、请求式开头，并由引擎把**紧跟在提问后面的短句**（≤20 字、10 秒内、上一段本身不是兜底捞上来的）当成追问——一句话被采集器切成两段时最容易漏报的就是这种尾巴。设计取向仍是「宁可多报」：漏报会丢掉面试官的问题，误报只是多答一次，所以默认档比旧版更灵敏。

**灵敏度现场校验（v1.6）**：`.test/live-sensitivity.ps1` 用 SAPI 合成三段中文（纯陈述 / 只含话题名词的句子 / 语气词提问，文字放在 UTF-8 的 `.test/.sens-lines.txt` 里），在 `strict`/`standard`/`high` 三档各环回播放一轮，再从 `/interview/status` 读每段的判定；脚本把 `targetSessionId` 设成一个不存在的 id，判定照跑但不会真往任何对话里投消息（`reason: 'no-session'`），跑完把 `dupWindowMs`、`targetSessionId`、`questionSensitivity` 复位。需要**非沙箱**进程（沙箱里 SAPI 报「系统上未安装任何语音」）：

```powershell
powershell.exe -NoProfile -File .test/live-sensitivity.ps1
```

**2026-10-17 实测**：纯陈述「我在研究生阶段负责ADC的校正工作。」三档都判 `not-a-question`（没有引入新的误报）；「我的项目难点在于时钟树和功耗。」在 `strict`/`standard` 下丢弃、在 `high` 下判提问（弱话题名词这条线索生效）；语气词句「你实习过吗」三档都判提问——SenseVoice 自己补了问号，所以 `strict` 与 `standard` 在真实音频上差别很小，实际增益主要来自 `high` 档与 `minQuestionChars` 6 → 4。转写仍有个别错字（`功耗`→`工号`、`时钟树`→`时钟数`），不影响判定。

**逐段收尾与立即回答（v1.7）**：静音判定的默认值从 700 ms 放宽到 **1000 ms**（`silenceMs`，范围不变）——面试官提问中间常有半秒到一秒的思考停顿，700 ms 容易把一句话切成两段，而前半段往往不带疑问线索、直接被判成陈述丢掉。放宽只是「略微延长」，切段上限仍是 `maxSegmentMs`（30 s）。

「立即回答」是这条链路上的手动出口：`POST /interview/answer-now`（面板按钮 / **Ctrl+Shift+U**）会**结束当前正在采集的那一段**并把它直接投递，不等静音切段、也不看它像不像提问，`minQuestionChars` 与 `minPeakRms` 也一并让路（只保留去重，避免同一句话投两遍）。三种时序都覆盖：正在录音 → `session.stop()` 提前收尾；已经录完、正在转写或正在判定 → 段对象上标 `manual: true` / `reason: 'manual'`，转写完立刻投递；不在监听或两段之间的空档 → 降级成「补答最近内容」（和 Ctrl+Shift+I 同路）。为了挡住极短误触，强制路径仍要求音频不短于 0.2 s，否则返回 `reason: 'nothing-heard'` 并把提示打在面板上；等待上限 12 s（`reason: 'timeout'`），监听被停掉时以 `reason: 'stopped'` 收尾。`GET /interview/status` 多了一个 `inflight` 字段（`{ recording, seconds, transcribing, answering }`，空闲为 `null`），面板据此显示「录音中 1.2s / 正在转写…」并把按钮点亮，所以「已经在转写但还没判定」这句话一眼可见、一键可答。

**立即回答现场校验（v1.7）**：`.test/live-answer-now.ps1` 把同一段**长陈述**（`.test/.now-lines.txt`，SAPI 合成）播两轮——第一轮正常播完（应当被判成陈述、`reason:'not-a-question'`），第二轮播到一半调 `POST /interview/answer-now`（应当被提前收尾、`manual:true` 且照投）。投递目标故意设成不存在的会话 id（`live-now-probe`），所以只会在 `/interview/status` 里看到转写、不会真的进任何对话；脚本还会打印录音中的 `inflight`、跑完把 `dupWindowMs`/`targetSessionId` 复位。同样需要**非沙箱**：

```powershell
powershell.exe -NoProfile -File .test/live-answer-now.ps1
```

**答案长度与长回答（v1.8）**：模式提示词里对答案长度的要求从「中文 120–250 字 / 英文 80–160 词」改成**按口读时间**约束——默认中文 **500–800 字**（口读约 2.5–4 分钟，硬上限 1200 字 ≈ 5 分钟），英文约 300–500 词（硬上限约 750 词），并且每个要点都要给细节（数字、取舍、踩过的坑），而不是堆形容词。

「长回答」（v1.8）是把同一道题再展开一遍的入口：面板上每条转写片段后面的「**长回答**」按钮（紧挨着「补答」）会把**这一条原文**重投，实时区/主面板按钮行里的同一个按钮则重投最近缓冲区；走 `POST /interview/answer-long`，消息以 `[模拟面试·长回答请求]` 开头，要求中文 1000–1200 字（英文约 650–750 词）的细节描述型长版本，结构固定为「结论 → 背景与目标 → 方案与关键细节（数字、取舍、失败与修复）→ 结果与一句话收尾」。它和补答一样**不看提问判定、不去重**，所以「先听短答、再点长回答」不会因为和上一句重复而被丢掉；缓冲为空时报「最近没有可长答的内容」。

> 长度是提示词约束、不是硬截断：模型一般会落在区间内，但真要压到精确秒数仍要看实际朗读速度（中文口播约 200–250 字/分钟）。觉得还是太长/太短，改 `lib/prompt.js` 的 `INTERVIEW_PROMPT` 与 `LONG_NOTE` 即可（宿主半，改完重启）。

## 注意

- **宿主半改动要重启 DSH Desktop**（宿主模块按进程缓存）；`lib/client.js` 的改动会热送到运行中的页面。
- 采集只监听**系统输出**（WASAPI loopback），不碰麦克风；停止监听即结束采集，应用退出前请先停。
- 音频不入库：每段的临时 WAV 在转写后即删除，只保留文字片段（滚动缓冲见 `maxSegments`）；文字片段也**不跨轮保留**——重新开始监听即清空。
