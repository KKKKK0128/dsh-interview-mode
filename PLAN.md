# 模拟面试模式 · 详细方案（v1.5）

> 交付范围：**只出方案，不动代码**（按你的选择）。本文所有 DSH 接口签名均已通过 `cordis_inspect_query` 核对；标注「待 P0 验证」的条目是尚未在运行时确认的假设。
>
> **v1.5 修订（2026-10-17，已落地）**：新增「**选择知识库**」——设置面板里可粘贴一个文件夹/文件路径并保存为候选（下拉框切换、可移除），宿主读取其中的文本资料（`.md/.txt/.json/代码…`，`.docx` 现场抽正文）**内联进每条提问消息**的 `[知识库]` 段，回答约束改为「先按资料作答，资料里没有的再按常识补充，不编造具体数据」；新增 `lib/knowledge.js`（扫描/抽取/体积预算，默认最多 40 个文件、单文件 8 KB、合计 24 KB）与 `GET /interview/knowledge`（只回摘要与文件清单，不回正文）。同版调整：**开始监听时清空上一次的片段与计数**（不再保留上一轮识别记录）。涉修订章节：§6.2、§6.4、§6.6、§6.7、§8。
>
> **v1.4 修订（2026-10-17，已落地）**：新增「**英文语音识别**」——`language` 设置支持 `auto` / `zh` / `en`（面板设置里的「识别语言」下拉框）；`auto` 不再沿用 provider 的固定语言提示，而是交给 SenseVoice 做语种识别，若转出的文本明显是英文再用 `en` 提示重转一次（每段最多一次，取英文内容更多的那次）；英文提问线索词扩到 30+ 条，英文提问用英文回答。涉修订章节：§1、§6.4、§8。
>
> **v1.3 修订（2026-10-16，已落地）**：新增「**选择对话**」——设置面板里可把提问固定投递到指定会话，默认 `targetSessionId: ''` 跟随当前打开的会话；新增 `GET /interview/sessions`（返回可投递的会话清单，含 `current`/`target` 标记），选中的会话若消失则**拒绝投递并报错**，不会改投到别的会话。涉修订章节：§3、§6.4、§6.6、§6.7、§8。
>
> **v1.2 修订（2026-10-16，已落地）**：界面拆成「**左面板只留设置 + 右侧栏转写标签页**」。转写历史、补答、启停监听移到 **DSH-better-sidebar**（`ctx.betterSidebar.registerTab`）提供的右侧栏标签页；`main` 面板退化为设置页。修订涉及的章节：§3、§4、§6.2、§6.6、§7、§9。
>
> **v1.1 修订（2026-10-15）**：UI 从「输入框图标按钮」改为「**侧边栏面板**」（左侧栏图标 + 主面板），输入框区域不再放本模式 UI；问答**直接作为聊天消息显示在对话里**。修订涉及的章节：§1、§3、§4、§5、§6.2、§6.6、§7、§9、§10。

---

## 1. 目标

在 DSH 里新增一个可选**模式**（mode），名为「模拟面试模式」：

1. 实时采集**电脑播放的声音**（面试官语音，WASAPI 环回，非麦克风）；
2. 本地转写 → 判定「这是一句提问」；
3. **自动**把该提问投递到当前会话，由会话里的 Agent 直接给出可照读的简短回答（聊天消息形式）；
4. 识别漏了 / 答得不好时，按**热键强制补答**（对最近一段音频再次提问）。

已确认的六个决策：

| 项 | 决策 |
| --- | --- |
| 实施方式 | 先只出本方案文档 |
| 触发 | 自动回答 + 热键强制补答 |
| 展示位置 | 作为聊天消息发给**当前会话**的 Agent |
| **问答展示** | **直接显示在对话里**（提问与回答都是普通聊天消息，不另做问答面板） |
| **UI 位置** | **放侧边栏**：左侧栏面板图标 + 主面板；输入框区域不放本模式控件 |
| 模型 | **跟随当前默认模型**（不单独配置模型） |

---

## 2. 复用资产（已落地并验证）

`dsh-system-audio`（需先装进 DSH profile，例如 `~/.dsh/profiles/desktop`；host 侧改动重启后生效）：

- `native/LoopbackRecorder.exe`：WASAPI 环回采集，输出 16000 Hz / 单声道 / 16-bit PCM（`transport: pipes` 或 `stdout`）；
- `lib/speech.js`：本地 SenseVoice（provider `sensevoice-local`），无需联网；
- HTTP 路由：`GET /system-audio/ping`、`GET /system-audio/devices`、`POST /system-audio/start`、`GET /system-audio/status?id=`、`POST /system-audio/stop {id}`；
- 3 个 Agent 工具：`system_audio_devices` / `system_audio_listen` / `system_audio_record`；
- 前端：`conversation.input.left` 槽位图标按钮（`id: dsh-system-audio`）——它是独立插件的通用能力，本模式**不复用**该按钮，见 §6.6 末条。

已验证的关键能力（可直接作为新模式的底座）：

- 电平事件约 **123 ms** 一个采样点，`status.levels[]` 可用于实时电平与静音判定；
- `silenceMs` 自动停止：实测 `{seconds:30, silenceMs:600}` 在语音结束后 **~1.0 s** 内 `state:'stopped'`；
- 转写质量：对 TTS 生成的中文句子，转写内容与原文一致（仅标点/空格差异）；
- 单段延迟参考：`inferenceSeconds ≈ 0.3 s`（11 s 音频）。

---

## 3. 交互流程（用户视角）

```
① 新建会话（或用当前会话）→ 在模式选择器里选「模拟面试模式」
        ↓
② 打开左侧边栏的「模拟面试」面板（图标：空闲灰 / 监听中带红点）
        ↓
③ 面板里点「开始监听」→ 开始环回采集（分段循环）
        ↓
④ 面试官说话 → 静音 0.7 s 判定一句结束 → 本地转写
        ↓
⑤ 是提问？ → 是：自动投递到**当前会话**（以聊天消息形式出现）
        │                        否：丢进「最近片段」缓冲（供热键补答）
        ↓
⑥ Agent 在聊天里给出可照读的回答（你就是看着读）—— 问答都在对话里
        ↓
⑦ 没答 / 答偏 → 按热键（默认 Ctrl+Shift+I）→ 对最近 ≤30 s 音频立刻再投一次
        （面板里也有「补答最近一段」按钮，等价）
```

---

## 4. 总体架构

```
┌───────────────────────────── DSH Host ─────────────────────────────┐
│  dsh-system-audio （已存在，需加一个服务导出）                      │
│    LoopbackRecorder.exe ──PCM/lvl──> 采集会话                       │
│    SenseVoice 转写                                                   │
│    ★ 新增 host 服务 `systemAudio`：captureSegment()/levels()/devices()│
│                                                                      │
│  dsh-interview-mode （新插件 · 模式插件）                            │
│    agentPresets.register({ id:'mock-interview', … })                 │
│    systemPrompt.section({ name:'interview-mode', … })                │
│    分段引擎（状态机）──> 问题判定 ──> 投递器 ──> sessionController.prompt()│
│    HTTP 路由（给前端）：/interview/{start,stop,status,answer-last}    │
└──────────────────────────────────────────────────────────────────────┘
                    ▲ fetch                    │ prompt 注入
                    │                          ▼
   ┌────────────────────────────┐   ┌──────────────────────────┐
   │ 浏览器前端(本插件)          │   │ 当前会话 Agent（默认模型）│
   │ 左侧栏图标 + 主面板         │   │ 在聊天里输出可照读回答     │
   │ （控制/状态/片段；无问答区） │   │ 提问与回答都落在对话中     │
   └────────────────────────────┘   └──────────────────────────┘
        ▲ 输入框区零改动：不放本模式任何控件
```

**分工原则**：采集与转写留在 `dsh-system-audio`（通用能力）；「模式 + 分段 + 判定 + 投递」放新插件 `dsh-interview-mode`（模式专属）。二者通过 **Cordis host 服务** 调用，不走 HTTP 内部通信。

---

## 5. 关键接口契约（已核对签名）

| 用途 | 接口 | 关键点 |
| --- | --- | --- |
| 注册模式 | `agentPresets.register(definition: PresetDefinition): Promise<() => Promise<void>>` | `{id, name?, description?, order?, plugins: EntryOptions[]}`；注册后进入新建会话的模式选择器；返回销毁函数 |
| 选中模式 | `agentPresets.select(agent: Agent, agentPreset: string): Promise<string>` | 会话第一轮开始前生效；`sessionController.create({ agentPreset })` 也可在创建时指定 |
| 模式提示词 | `systemPrompt.section(section: PromptSection): () => void` | `{name, order, text}`；同名段在作用域内覆盖全局段 |
| 投递提问 | `sessionController.prompt(request: SessionPromptRequest, signal): Promise<SessionPromptValue>` | **`SessionPromptRequest = { requestId, sessionId, mode: 'queue' \| 'steer', content: PromptContentPart[], clientTimeZone? }`**；`mode:'queue'` 排队到下一轮，`'steer'` 在当前轮插入；返回 `{ accepted: true }` |
| 建会话 | `sessionController.create(request): Promise<SessionCreateValue>` | `{ workspaceId?, cwd?, sessionId?, agentPreset? }` |
| 会话列表 | `sessionController.list(request, signal)` | `SessionSummary{ sessionId, running, blank, agentAvailable, … }` → 可判断会话是否忙 |
| 打断 | `sessionController.cancel({sessionId})` | 长回答占住轮次时可取消 |
| 当前模型 | `agentDefaultModel.currentSelection()` | 决策 6：**不**单独配置模型 |
| 模型目录 | `sessionController.modelCatalog(): Promise<ModelCatalog>` | 需要时可展示，但默认不选模型 |
| 转写（备选） | `speechController.transcribe(request, signal): Promise<Transcript>` / `speechToText.transcribe(spec, signal)` | DSH 自带语音服务；`speechController` 的说明是「永不激活或提交 Agent」 |
| 直连模型（备选） | `llm` 服务：`PreparedLlmCall.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` | **本项目不采用**（决策 3/6 让会话 Agent 来答），仅作降级备选 |
| **侧边栏图标** | client 槽位 `sidebar.panellist`（**list**，root 作用域） | 注册 `{ id: 'interview', order: 40, label: () => t('模拟面试') }`；`replaceRisk: none`；现有占位 `plugins`(0)/`schedules`(10)/`mnemon`(30)；图标组件 ownerProps 为 `{ size: number; active: boolean }` |
| **主面板** | client 槽位 `main`（**keyed**，root 作用域） | 注册 `{ key: 'interview' }`；keyDomain 原文「Central panel selected by sidebar entry id；保留键 `conversation` 承载会话，**其它 key 不绑定会话**」；已占用 key：`plugins`/`schedules`/`mnemon`/`xmanrui-dsh-im`/`conversation` |
| 模式选择控件 | `conversation.hero.agentPreset`（single） | 新建会话时的模式选择，由 shell 提供；本插件只需注册 preset |
| 可选浮层 | `shell.overlay`（list，root） | 仅当需要全窗提示时才用；**v1.1 默认不用** |

> 待 P0 验证：`PromptContentPart` 的确切联合类型（推测为 `{type:'text', text}` 这类块，与 `TextBlock` 同形）；`PresetDefinition.plugins` 的行能否解析 **profile 级**安装的包（推断可以，因为 `EntryOptions` 就是 cordis.yml 的行形状）。

---

## 6. 组件设计

### 6.1 模式声明（preset）

```js
// 伪代码：dsh-interview-mode 的 apply(ctx)
ctx.agentPresets.register({
  id: 'mock-interview',
  name: '模拟面试模式',
  description: '实时采集电脑音频，自动把面试官提问变成可照读的回答',
  order: 50,
  plugins: [
    { name: 'dsh-system-audio' },   // 采集底座（profile 已装，行内引用）
    { name: 'dsh-interview-mode' }, // 本插件：引擎 + UI
  ],
});
```

- 模式只做两件事：**把插件挂进会话组合** + **注入模式提示词段**；
- 用户仍可用普通会话：普通会话里这两个插件不挂载，互不影响。

### 6.2 分段引擎（核心状态机）

```
idle ──start()──> listening ──(采集到语音)──> speaking
   ▲                 ▲                          │
   │                 │                    静音 ≥ silenceMs
   │                 │                          ▼
   │            立刻开下一段 <──转写/投递── segment-done
   │                                            │
   └──────────── stop() ────────────────────────┘
```

- 实现方式：**循环 start/stop**（复用已验证的 `silenceMs` 自动停止），而不是新写流式 VAD —— 风险最低；
- 每段参数：`silenceMs=700`、`minSpeechMs=800`（电平阈值判定，低于则丢弃，防咳嗽/键盘声）、`maxSegmentMs=30000`（硬上限）、段间冷却 `cooldownMs=300`；
- **滚动缓冲**：最近 ≤30 s 的段落转写保存在环形缓冲里，供热键补答；
- **去重**：与上一段文本相似度 ≥0.9 且间隔 <10 s 的片段丢弃（防回声/重复触发）；
- **监听中的可见性**（v1.1 改到侧边栏）：侧边栏图标画红点/脉冲 + 主面板顶部显示「监听中 · 当前电平 · 最近一句」。**不使用** `shell.overlay`，也不在输入框区插任何东西。

### 6.3 问题判定（两道闸）

1. **启发式**（默认，零成本）：文本含 `？/?`，或以 `吗/呢/什么/怎么/为什么/如何/哪/谁/几点/介绍/说说/举例/区别/优缺点` 等词开头/结尾；含英文 `what/why/how/when/which/can you/tell me/describe`；
2. **LLM 闸**（可选，默认关）：对启发式命中的文本用 `llm.stream` 打一个 `YES/NO`（成本极低）；默认关，避免额外 token 与延迟。

命中的文本进入投递器；未命中但长度 ≥ 12 字的进入「最近片段」缓冲（热键补答的素材）。

### 6.4 投递器

- 投递格式（明确标注来源，便于 Agent 区分人/机器；这条消息**就是**对话里出现的那条提问）：

```
[模拟面试·面试官提问] {转写文本}
（来源：电脑音频自动转写，可能有错字；请直接给出可照读的口语化回答）
```

- **目标会话（v1.3）**：投递对象由 `settings.targetSessionId` 决定——空串 = 每次投递前重新挑「最近更新的非空会话」（原行为）；非空 = 固定投到那个会话，`sessionController.list()` 里找不到它时**拒绝投递**并在片段上标 `reason:'no-session'`、在 `errors` 里报「选定的对话已不存在」，绝不静默改投。
- **自动投递**：判定命中即投；同一文本 10 s 内只投一次；
- **知识库（v1.5）**：若 `settings.knowledgeBase` 非空，投递时把 `collectKnowledge()` 的 `block`（带 `[知识库]` 标记、来源路径、`--- 相对路径 ---` 分隔的正文）追加在提问文本之后；资料在宿主侧读盘并做 5 分钟热缓存，面板通过 `GET /interview/knowledge` 只看摘要，正文不下发。
- **热键补答**：`POST /interview/answer-last` → 取滚动缓冲最近 ≤30 s → 投递，格式为 `[模拟面试·补答请求] …`（侧边栏面板里的「补答最近一段」按钮走同一条路径）；
- **忙时策略**（关键）：若 `sessionController.list()` 里本会话 `running === true`（Agent 正在回答上一问），则：
  - 默认 `mode:'queue'` 排队，避免打断；
  - 若排队积压 ≥2 条，只保留最新一条（丢弃过期提问，避免答非所问的雪崩）；
  - 配置项 `interruptWhenBusy`（默认 `false`）可改为 `cancle + steer`（先 `cancel` 再 `mode:'steer'`）。
- 投递失败（`accepted` 未返回）写入本地日志 + 面板里红点提示，不静默丢。

### 6.5 模式提示词段（草案全文）

```text
你是「模拟面试模式」里的面试副手。

当收到以 [模拟面试·面试官提问] 或 [模拟面试·补答请求] 开头的消息时：
1. 立刻给出**可直接照读**的口语化中文回答，长度 120–250 字；
2. 结构：先一句结论/定义，再 2–3 个要点，必要时补一个例子或数字；
3. 不要复述问题，不要寒暄，不要「好的/当然可以」这类开场；
4. 不要调用工具、不要反问、不要要求澄清；信息不足时按最合理的常识假设作答；
5. 技术问题优先给：定义 → 原理/流程 → 常见坑 → 一句话总结；
6. 若同一条提问与上文高度重复，用一句话补充差异点即可。

除以上消息外，保持正常的编程助手行为。
```

（该段用 `systemPrompt.section({ name:'interview-mode', order:30, text })` 注入，随模式作用域生效。）

### 6.6 前端（浏览器侧）—— **左面板设置 + 右栏转写标签页**（v1.2 重写，已落地）

**座位划分**（DSH 原生槽位 + `DSH-better-sidebar` 的客户端服务）：

| 位置 | 内容 | 注册方式 |
| --- | --- | --- |
| 左栏图标 | 「模拟面试」图标（空闲灰 / 监听中红点脉冲） | `sidebar.panellist`（list）：`{ id:'interview', order:40, label }` |
| 左栏主面板 | **只留设置**：开始/停止监听、输出设备、静音阈值/最短语音、自动回答、热键说明、未选会话提示，以及「打开转写标签页」按钮 | `main`（keyed，key `'interview'`） |
| 右侧栏标签页 | **转写历史 + 补答 + 启停**：实时电平、最近一句、片段列表（时间/文本/是否已投递/补答/复制）、开始/停止 | `ctx.betterSidebar.registerTab({ id:'dsh-interview-mode:transcript', order:120, single:true, component })` |
| 会话对话区 | 问答本体：提问以 `[模拟面试·面试官提问] …` 进入当前会话，Agent 回答是普通回复 | 无 UI |
| 输入框区 `conversation.input.*` | 零改动 | 无 UI |

**可选依赖**：`dsh-better-sidebar` 只做增强。客户端按 `ctx.get('betterSidebar') ?? ctx.betterSidebar` 探测（先 cordis 服务访问器，再文档里的属性形式——实测活动页面只有前者可靠），缺席时插件照常工作：面板退回 `full` 变体（历史与补答仍在面板里），不注册标签页。两个客户端半的加载顺序不定，注册放在 `500 ms × 60` 的探测 effect 里；返回的 disposer 由该 effect 持有、随插件销毁（热重载安全）。重复 id（热重载与旧实例的 disposer 抢跑）只记一次日志并继续重试，绝不让客户端半整体失败。

**实现要点**：

1. **渲染期绝不调用 owner hook**（如 `props.useSessions()`）。历史上这样写过一次，触发 React #311「Rendered fewer hooks than expected」，面板整块空白且没有可见错误。当前会话 id 只从普通字段读：`props.sessionId` / `props.activeSessionId` / `props.session.sessionId`；标签页用 better-sidebar 传入的 `props.scope.sessionId`；真正的投递目标由宿主引擎解析。
2. 面板与标签页共用同一组件，靠 `variant`（`full` / `settings` / `tab`）决定渲染哪些 section；**hook 调用顺序与所有 section 的构造不随 variant 变化**（同样是 #311 的教训）。
3. 打开标签页：`betterSidebar.openTab({ type, title }, { sessionId })`；开始监听成功后自动打开一次（`AUTO_OPEN_TAB`，默认开）。

### 6.6b 附录：v1.1 的侧边栏面板设计（已被 §6.6 取代）

**已核对的槽位事实**（`cordis_inspect_query client/Slots.listSubTree`）：

- `sidebar` 是 single / `shadows-shipped-ui`，被 `ui-sidebar` 的 SidebarRoot 占用，catalog 明确「registering here replaces the navigation column outright」——**绝不能**注册它；里面的 `sidebar.workspaces`、`sidebar.settings`、`sidebar.brand.*` 等同理（都是 shipped UI 的座位）。
- `sidebar.panellist`：**list**、root 作用域、`replaceRisk: none`，注册签名 `{ id(必填), order?, label? }`；现有占位 `plugins`(order 0)、`schedules`(10)、`mnemon`(30)。catalog 原文：*"Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata."* 图标组件收到的 ownerProps：`{ size: number; active: boolean }`。
- `main`：**keyed**、root 作用域、`replaceRisk: shadows-shipped-ui`，注册 `{ key(必填) }`；已占用 `plugins` / `conversation` / `schedules` / `xmanrui-dsh-im` / `mnemon`。用一个**新 key** 是新增座位，不会替换别人的面板；但 catalog 也写明「**其它 key 不绑定会话**」（只有保留键 `conversation` 承载会话）。

**设计**：

| 位置 | 内容 |
| --- | --- |
| `sidebar.panellist` | 注册 `{ id:'interview', order:40, label:() => t('模拟面试') }`；图标组件自己画状态：空闲灰、监听中加红点/脉冲（ownerProps 只给 `size`/`active`，状态灯由本插件组件渲染）。点击后由 shell 切到 `main` 的同名 key。 |
| `main` key `'interview'` | **主面板（整栏）**：① 开始/停止监听 + 状态灯；② 输出设备选择（复用 `/system-audio/devices`）；③ 实时电平条 + 最近一句转写；④ 最近片段列表（时间 / 文本 / 是否已投递 / 「补答」/「复制」）；⑤ 关键配置（自动回答、显示热键、静音阈值）；⑥ 未选会话时的提示。 |
| **会话对话区** | **问答就在这里**：`[模拟面试·面试官提问] …` 与 Agent 的回答都是普通聊天消息，无需额外 UI。 |
| 输入框区（`conversation.input.*`） | **零改动**：本模式不放任何控件（按你的要求）。 |
| 热键 | `Ctrl+Shift+I` 强制补答（文档级 `keydown`，卸载时注销）。 |

**主面板的两个实现要点**：

1. **面板不绑定会话** ⇒ 面板必须自己记住「当前会话」：客户端用 `useSessions()`（或 `sessions` 服务的 `using/scope/binding`）拿当前会话 id，作为 `sessionController.prompt` 的 `sessionId`；没有会话时面板显示「请先打开一个会话」并禁用投递。切换会话时面板内容不变（它是全局面板），但投递目标跟着变。
2. 面板状态来自本插件自己的 HTTP 路由 `/interview/*`（`status/start/stop/answer-last`），与 `dsh-system-audio` 的 `/system-audio/*` 分工明确：前者管模式与投递，后者管采集与转写。

**与现有 `dsh-system-audio` 按钮的关系**：它在 `conversation.input.left` 的录音按钮**保持不变**（独立插件的通用能力，不属于本模式 UI）。如果你希望它也一并挪进这个侧边栏面板，我可以在 P2 顺带做（见 §10 第 6 条）。

### 6.7 配置项（草案）

```yaml
# 会话内插件配置（走 DSH 的插件 config，即 preset 行的 config 字段）
deviceId: null          # null = 跟随系统默认播放设备
targetSessionId: ''     # '' = 跟随当前打开的会话；非空 = 固定投递到该会话（v1.3）
knowledgeBase: ''       # 当前选中的资料文件夹/文件；'' = 不使用知识库（v1.5）
knowledgeList: []       # 面板保存过的候选路径（最多 20 条，下拉框选项）（v1.5）
autoStart: false        # 打开会话就自动开始监听
autoAnswer: true        # 自动投递（决策 2）
silenceMs: 700          # 静音判停
minSpeechMs: 800        # 最短语音
maxSegmentMs: 30000     # 单段硬上限
cooldownMs: 300
dupSimilarity: 0.9      # 去重阈值
hotkey: 'Ctrl+Shift+I'
interruptWhenBusy: false# 忙时是否打断
llmGate: false          # 是否用 LLM 二次判定
language: auto          # 转写语言
maxBufferSeconds: 30    # 滚动缓冲
panelOrder: 40          # 侧边栏图标位置
```

---

## 7. 分阶段实施计划

| 阶段 | 内容 | 验收标准 | 估时 |
| --- | --- | --- | --- |
| **P0 可行性 spike** | ① 注册最小 preset，确认模式选择器里真的出现「模拟面试模式」；② 在 host 插件里成功调用 `sessionController.prompt`（向当前会话投一条消息并触发回答）；③ **在侧边栏出现 `interview` 图标并能切到主面板**；④ 连续分段循环跑 10 分钟无泄漏、无音频设备占用残留 | 四项全绿 | 1–1.5 h |
| **P1 引擎** | `dsh-system-audio` 导出 `systemAudio` host 服务；`dsh-interview-mode` 落地分段引擎 + 判定 + 投递 + 滚动缓冲 + 路由 | 用一段真实中文提问音频，能自动投递并收到回答；热键补答可用 | 3–5 h |
| **P2 UI（侧边栏）** | `sidebar.panellist` 图标（含状态红点）+ `main` 主面板（控制/电平/片段/配置） + 热键 + 无会话兜底 | 侧边栏里能开关与观察；对话里能看到问答；**输入框区域零改动** | 3–4 h |
| **P3 打磨** | 去重/忙时策略调参、片段面板细化、错误提示、README、离线 battery | 30 分钟长跑零误投、零丢失 | 2–3 h |

风险点前置在 P0：若 `sessionController.prompt` 在 host 插件里不可用（例如远程装饰器限制），降级为 `llm.stream` 直连模型 + 由本插件把「提问/回答」当作自己的消息渲染——但那样问答就不在对话里了，所以这条降级会先回来跟你确认。

---

## 8. 测试计划

1. **离线 battery**（node + 假 WAV，不需要应用）：
   - 分段：静音 0.5 s 切段正确；`maxSegmentMs` 截断；
   - 判定：10 条提问 / 10 条陈述的分类正确率记录；
   - 去重：同一音频播两遍只投一次；
   - 缓冲：热键取到最近一段；
   - 选择对话（v1.3）：`listSessions` 过滤空/子代理会话并按更新时间排序；固定会话存在时优先于最近会话；固定会话消失时拒绝投递（`reason:'no-session'` + `errors`）。
   - 英文识别（v1.4）：`detectLanguage` 中英判定、英文提问线索、显式 `en` 不重转、`auto` 下英文重转一次并保留英文结果；
   - 知识库（v1.5）：路径规范化/去重限量、目录扫描的包含与排除（`node_modules`、隐藏文件、超深目录、超大文件、空文件、不支持格式）、体积截断与总预算、**两遍遴选（先抽正文，再按正文从小到大装预算）**、`.docx` 只受 8 MB 原始体积粗筛、内联块结构、投递消息带 `[知识库]` 段、`start()` 清空上一轮片段（`.test/knowledge-check.mjs` + engine/host/client 三套 battery）。
2. **线上 E2E**（真实应用 + TTS 音频）：用 SAPI 生成已知中文提问（已有 `speech-zh.wav` 同类脚本）→ 播放 → 期望**对话里**出现 `[模拟面试·面试官提问] 已知文本` + Agent 回答；跑 3 轮。
3. **UI 验收**：`client/Slots.listSubTree {root:'sidebar.panellist'}` 出现 `interview`（order 40），`{root:'main'}` 出现 key `interview`；点图标能进/出面板；面板里开始/停止监听生效；侧边栏折叠（rail）时图标仍可用。
4. **稳定性**：连续 30 分钟播放音频片段，检查内存/句柄、设备是否被独占、投递条数与真实提问数一致。
5. **错误路径**：无默认设备、录音进程被杀、转写失败、会话忙、无打开会话、**选定的对话消失（v1.3：拒绝投递并提示，不改投）**、Agent 报错 —— 每种都要有明确提示且能自动恢复下一段。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| `sessionController.prompt` 在 host 插件内不可调用 | 主线方案受阻 | P0 先验证；降级 `llm.stream` 直连（但会牺牲「问答在对话里」，需先确认） |
| preset 行无法解析 profile 插件 | 模式挂不起引擎 | P0 验证；备选：模式插件自身即引擎，`plugins` 只含自己一行 |
| **`main` 主面板不绑定会话** | 可能把提问投到错误的会话 | 面板自跟踪当前会话 id；无会话时禁用投递并提示；切换会话时高亮当前目标 |
| **`main` key 与别人撞名** | 会替换掉别人的主面板 | 用独有 key `interview`；注册前用 `client/Slots.listSubTree{root:'main'}` 核对已占用 key |
| **侧边栏面板常驻，用户切走会话仍在监听** | 误录 / 误投 | 图标红点 + 面板状态常显；提供一键暂停；可选「切走会话自动暂停」配置 |
| 循环分段引入 0.3–1 s 延迟 | 回答慢半拍 | 属可接受（提问结束后才答）；P3 可评估流式 VAD |
| 误触发（视频/音乐/自己说话） | 会话被垃圾提问淹没 | 判定两闸 + 去重 + 忙时只留最新 + 一键暂停 |
| 转写文本进入会话日志 | 隐私 | 明确提示；投递文本显式标注来源，便于事后清理 |
| 热键冲突（现有插件用 Ctrl+Shift+Y） | 功能互相触发 | 新模式默认 Ctrl+Shift+I，可配置 |

---

## 10. 需要你确认的点（下一步）

1. **热键**：`Ctrl+Shift+I` 可以吗？
2. **忙时**：Agent 正在回答上一问时，新提问**排队**（默认）还是**打断重答**？
3. **自动开始**：进入模式就自动开监听，还是每次都到侧边栏面板点一下「开始监听」？
4. **回答风格**：120–250 字、先结论后要点（当前草案），是否符合你的面试场景？（也可换成「30 秒口播稿」或「要点提纲」）
5. **侧边栏图标位置**：排在 `mnemon` 之后（`order: 40`）可以吗？
6. 现有 `dsh-system-audio` 在输入框里的录音按钮，要不要**一起挪进**这个侧边栏面板？（默认不动）
7. 确认后从 **P0 spike** 开始动代码。

---

## 附：涉及文件

- 现有：`dsh-system-audio\`（`lib/index.js`、`lib/routes.js`、`lib/speech.js`、`lib/recorder.js`、`lib/client.js`、`native\LoopbackRecorder.exe`、`.test\`）
- 新增（待建）：`dsh-interview-mode\`（`package.json`、`lib/index.js`、`lib/engine.js`、`lib/routes.js`、`lib/prompt.js`、`lib/knowledge.js`、`lib/client.js`、`.test\`）
- 参考：DSH Inspect 查询输出（`host/Service.listService`、`client/Slots.listSubTree{root:'sidebar'|'sidebar.panellist'|'main'}`），用于核对上表签名与槽位
