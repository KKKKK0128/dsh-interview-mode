# dsh-interview-mode — 模拟面试模式

一个 DSH Desktop 的「模式」插件（`agentPresets` 里的 **mock-interview / 模拟面试模式**）：把电脑正在播放的声音**实时**采集下来，本地转写成文字，自动判断其中哪些话是**面试官提问**，再把提问作为聊天消息投递给**当前会话**的 Agent，让答案直接出现在对话里。

- 采集与识别复用已装的 [`dsh-system-audio`](../dsh-system-audio)（WASAPI 环回 `native/LoopbackRecorder.exe` + 本地 SenseVoice），本插件只负责**分段、判定、投递、界面**。
- 设计文档见 [`PLAN.md`](./PLAN.md)（v1.5，含取舍与被否掉的方案）。

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
| 查看转写历史 | 右侧栏标签页：实时电平、最近一句、片段列表（时间 / 文本 / 是否已投递 / 补答 / 复制）。**每次开始监听都会清空上一轮的片段与计数** |
| 打开转写标签页 | 开始监听后自动打开一次；也可在右侧栏 `+` 菜单里选「模拟面试转写」 |
| 设备 / 静音阈值 / 自动回答 | 左栏「模拟面试」图标 → 主面板（**只留设置**），写 `POST /interview/config` |
| 选择投递到哪个对话 | 主面板设置里的「**选择对话**」下拉框（`targetSessionId`）。默认 `Auto` = 跟随当前打开的会话；选中某个对话后，所有提问都投到它，选中的对话被关掉时**拒绝投递并提示**，不会改投到别的会话 |
| 识别语言（中文 / 英文） | 主面板设置里的「**识别语言**」下拉框（`language`）。`auto` = 交给 SenseVoice 做语种识别，英文句子会自动再以 `en` 提示重转一次；面试全程英文时直接选 `English`，省掉这次重转。提问判定对英文线索（what / why / could you / tell me about / experience / challenge …）同样生效，英文提问会用英文回答 |
| 提问与答案 | **对话里**：提问以 `[模拟面试·面试官提问] …` 消息进入当前会话，Agent 的回答就是普通回复 |
| 选择知识库 | 主面板设置里的「**知识库**」：把资料**文件夹或文件**的完整路径粘进输入框 → 「添加」（回车也行），下拉框切换、可「移除」。宿主读取其中的文本资料（`.md/.txt/.json/代码` 等，`.docx` 现场抽正文）并**内联进每条提问消息**的 `[知识库]` 段，回答优先依据它；提示行显示「已内联 N/M 个文件 · xx KB」或错误原因 |

右侧栏标签页由可选插件 [`DSH-better-sidebar`](https://www.npmjs.com/package/dsh-better-sidebar) 提供（DSH 客户端服务 `ctx.betterSidebar`）；没装它时插件自动退回「全部功能都在左面板」的旧形态，不报错。面板与标签页的内容超出高度时可**上下滚动**（转写列表另有独立滚动区，最多占 46vh，保证上方的开关始终可见）。

采集是「按静音切段」的循环：每段独立录音 → 转写 → 判定 → 投递，所以长面试不会攒成一个巨型音频。

## 默认参数

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `silenceMs` | 700 | 静音多久算一句结束（250–10000） |
| `minSpeechMs` | 800 | 短于这个时长的段直接丢弃 |
| `minPeakRms` | 0.008 | 峰值低于此电平算静音段，丢弃（不进入缓冲、不投递） |
| `maxSegmentMs` | 30000 | 单段上限（对应录音 `seconds` 的推导） |
| `cooldownMs` | 300 | 两段之间的冷却 |
| `dupSimilarity` / `dupWindowMs` | 0.9 / 10000 | 10 秒内相似度 ≥0.9 的提问视为重复，丢弃 |
| `minQuestionChars` | 6 | 归一化后短于 6 字的段不投递 |
| `autoAnswer` | true | 自动投递；关掉后只能热键补答 |
| `targetSessionId` | `''` | 投递目标对话：`''` = 跟随当前会话；非空 = 固定投到该会话 |
| `maxBufferSeconds` / `maxSegments` | 30 / 60 | 滚动缓冲，供「补答最近一句」 |
| `interruptWhenBusy` | false | Agent 忙时排队（**默认**），true 才 `cancel` 后 `steer` |
| `language` | `auto` | 识别语言：`auto` = 交给 SenseVoice 语种识别（英文段再以 `en` 重转一次兜底）；`zh` / `en` = 强行按该语言转写 |
| `knowledgeBase` | `''` | 当前选中的资料文件夹/文件，`''` = 不使用知识库；内容会内联进每条提问消息 |
| `knowledgeList` | `[]` | 面板保存过的候选路径（最多 20 条，下拉框选项） |
| `hotkey` | `Ctrl+Shift+I` | 页面内热键 |

## 路由（宿主半，`webServer.register` 的 exact 路由）

```
GET  /interview/ping         → { ok, engine:'idle'|'listening', sessionId, preset:{id,ok,error,registeredAt} }
GET  /interview/status       → 状态快照：state/sessionId/level/lastText/delivered/dropped/errors/settings/segments[]
GET  /interview/sessions     → { ok, error, items:[{ sessionId, title, updatedAt, running, blank, current, target }], current, target }
GET  /interview/knowledge    → { ok, path, kind, error, included, totalFiles, bytes, truncated, blockChars, files:[{ rel, bytes, included, reason }] }（?path= 指定路径，缺省用当前配置；?refresh=1 跳过热缓存。**不下发内联正文**）
GET  /interview/devices      → { ok, default, devices[], speech }
POST /interview/start        → { ok, state }   body: { sessionId?, deviceId? }
POST /interview/stop         → { ok, state }
POST /interview/answer-last  → { ok, delivered, text }   热键/按钮的补答
POST /interview/config       → { ok, settings }  body: { deviceId?, autoAnswer?, silenceMs?, targetSessionId?, language?, knowledgeBase?, knowledgeList?, hotkey?, interruptWhenBusy? }
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
lib/routes.js   9 条 exact 路由 + JSON 助手
lib/client.js   浏览器半：sidebar.panellist 图标（id interview, order 40）+ main 面板（key interview）
cordis.patch.yml / package.json   bundle 元数据（dsh.bundle.patch / dsh.client.platform）
```

依赖：`dsh-system-audio`（两个仓库请**克隆到同一父目录**，本仓库用 `node_modules` 软链引用 `dsh-system-audio/recorder` 与 `dsh-system-audio/speech`；如果两个包都已发到 npm，把 `package.json` 里的 `link:../dsh-system-audio` 换成 `^0.1.0` 即可）。

## 测试

```bash
NODE="$USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
"$NODE" .test/engine-check.mjs     # 33/33：提问判定（含英文线索）、相似度、会话选择（含固定目标会话 / 目标消失拒投）、分段引擎、忙时排队、静音段丢弃、config 夹取、英文识别（语言提示 + 自动重转）、知识库（摘要/缓存/内联进投递消息/规范化/开始监听清空记录）
"$NODE" .test/knowledge-check.mjs  # 26/26：路径规范化、目录扫描的包含与排除、体积截断与总预算（小文件优先）、.docx（现场生成的 zip）正文抽取、无资料时的降级文案
"$NODE" .test/host-check.mjs       # 12/12：9 条路由行为（含 GET /interview/knowledge）+ 卸载
"$NODE" .test/client-check.mjs     # 侧边栏注册 + 面板渲染 + 选择对话 + 识别语言 + 知识库下拉框（含 dsh-system-audio 不再注册输入框按钮）
```

现场端到端（**需要非沙箱**：沙箱进程放出的声音进不了环回采集）：

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

## 注意

- **宿主半改动要重启 DSH Desktop**（宿主模块按进程缓存）；`lib/client.js` 的改动会热送到运行中的页面。
- 采集只监听**系统输出**（WASAPI loopback），不碰麦克风；停止监听即结束采集，应用退出前请先停。
- 音频不入库：每段的临时 WAV 在转写后即删除，只保留文字片段（滚动缓冲见 `maxSegments`）；文字片段也**不跨轮保留**——重新开始监听即清空。
