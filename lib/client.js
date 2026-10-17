// dsh-interview-mode — browser half.
//
// Hand-written in the client module format DSH expects (identical contract to
// dsh-system-audio/lib/client.js): this file only registers a factory, and the
// module body runs when the shell materializes it. It needs nothing beyond
// React and the plugin context, so there is no build step and no generated
// Typert artifact — capture, transcription, question judging and delivery all
// live in the host half behind /interview/* and /system-audio/*.
//
// UI placement (v1.2 of PLAN.md): the left sidebar seat plus a DSH-better-sidebar
// tab. Two DSH slots are registered — `sidebar.panellist` (list, id 'interview')
// and `main` (keyed, key 'interview') — and, when the optional `betterSidebar`
// client service is present, one tab type (`TAB_ID`) that renders the live
// transcript in DSH's own right sidebar. Nothing is registered into
// `conversation.input.*`; the composer is untouched by this plugin.
//
// Split of duties: the right-sidebar tab owns the live surface (transcription
// history, 补答 / re-answer, start/stop listening, level meter); the left panel
// keeps the settings only (device, auto answer, silence threshold, shortcut and
// the legacy "record a clip and transcribe" tool, which writes into the current
// draft through `inputActions`). Without better-sidebar the left panel degrades
// back to the full surface, so no control ever becomes unreachable.
window.__ModuleLoader__.load({
	id: "dsh-interview-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const NS = "dsh-interview-mode";
		const PREFIX = "/interview";
		const AUDIO = "/system-audio";
		const ICON_ID = "interview";
		const CONFIG_DEBOUNCE_MS = 300;

		// Live status polling cadence for the panel (host half is cheap and
		// in-memory, so 700 ms keeps the level meter and latest sentence fresh).
		const STATUS_POLL_MS = 700;
		// Recorder polling cadence for the migrated "record a clip" flow — it
		// mirrors dsh-system-audio's own composer row (150 ms level samples).
		const CAPTURE_POLL_MS = 150;
		const CAPTURE_MAX_SECONDS = 120;
		const DEFAULT_CLIP_SECONDS = 15;
		const CAPTURE_DEVICE = "default";
		const HOTKEY_KEY = "i";

		// DSH-better-sidebar tab type carrying the live transcript. The id doubles
		// as the native tab `type`; the ':' prefix keeps it out of the builtin id
		// space. `single: true` makes every open focus the one existing tab.
		const TAB_ID = "dsh-interview-mode:transcript";
		const TAB_ORDER = 120;
		// Starting a listening session reveals that tab, so the history is where
		// the reader looks without a second click. Set to false to keep it manual.
		const AUTO_OPEN_TAB = true;
		// A client half may load before the better-sidebar one, so when the service
		// is not up yet we poll briefly (500 ms × 60) instead of giving up.
		const SIDEBAR_PROBE_MS = 500;
		const SIDEBAR_PROBE_TRIES = 60;

		const strings = {
			zh: {
				title: "模拟面试",
				panelTitle: "模拟面试模式",
				stateIdle: "空闲",
				stateListening: "监听中",
				stateOffline: "离线",
				start: "开始监听",
				stop: "停止监听",
				goal: "目标会话",
				goalNone: "未打开会话（将投递到最近会话）",
				goalUnknown: "跟随最近会话",
				deviceSection: "输出设备",
				device: "监听设备",
				deviceDefault: "系统默认设备",
				deviceRefresh: "刷新设备",
				speechReady: "转写就绪",
				speechNotReady: "转写未就绪",
				speechUnknown: "转写状态未知",
				live: "实时",
				level: "电平",
				lastText: "最近一句",
				lastTextEmpty: "（暂无）",
				segments: "片段",
				segmentsEmpty: "还没有片段。",
				segTime: "时间",
				segText: "文本",
				segDelivered: "已投递",
				segPending: "未投递",
				answer: "补答",
				copy: "复制",
				copied: "已复制",
				cloneFailed: "复制失败，请手动选择文本",
				config: "配置",
				sessionLabel: "目标对话",
				sessionAuto: "跟随当前会话（自动）",
				sessionUntitled: "未命名会话",
				sessionRunning: "运行中",
				sessionCurrent: "当前",
				sessionRefresh: "刷新对话",
				sessionEmpty: "没有可选的会话",
				sessionHint: "提问会投递到选中的对话；选「自动」时跟随你当前打开的会话。",
				autoAnswer: "自动回答",
				silenceMs: "静音阈值 (ms)",
				hotkeyLabel: "热键",
				clip: "录一段并识别",
				clipSeconds: "秒数",
				clipRunning: "录制中",
				clipStopping: "转写中…",
				clipEmpty: "没有识别到语音",
				clipInserted: "已写入输入框草稿",
				clipManual: "输入框不可写，文本已复制到剪贴板",
				clipFailed: "录制或转写失败",
				delivered: "已投递",
				deliverFailed: "投递失败",
				clipInsertedFlag: "已插入",
				clipManualFlag: "写入未生效",
				sidebarSection: "侧边栏转写面板",
				sidebarHint: "转写历史、补答和监听开关都在右侧边栏的「模拟面试」标签页里。",
				sidebarOpen: "在侧边栏打开转写面板",
				sidebarOpened: "已在侧边栏打开",
				sidebarUnavailable: "没有检测到 DSH-better-sidebar：转写历史、补答和监听开关仍留在本面板。",
				tabTitle: "模拟面试",
				tabDesc: "转写历史、补答与启停监听",
				minutes: "分",
				seconds: "秒",
			},
			en: {
				title: "Mock interview",
				panelTitle: "Mock interview mode",
				stateIdle: "Idle",
				stateListening: "Listening",
				stateOffline: "Offline",
				start: "Start listening",
				stop: "Stop listening",
				goal: "Target session",
				goalNone: "No session open (will deliver to the most recent one)",
				goalUnknown: "Follows the most recent session",
				deviceSection: "Output device",
				device: "Capture device",
				deviceDefault: "System default device",
				deviceRefresh: "Refresh devices",
				speechReady: "Transcription ready",
				speechNotReady: "Transcription not ready",
				speechUnknown: "Transcription state unknown",
				live: "Live",
				level: "Level",
				lastText: "Latest sentence",
				lastTextEmpty: "(none yet)",
				segments: "Segments",
				segmentsEmpty: "No segments yet.",
				segTime: "Time",
				segText: "Text",
				segDelivered: "Delivered",
				segPending: "Not delivered",
				answer: "Answer again",
				copy: "Copy",
				copied: "Copied",
				cloneFailed: "Copy failed — select the text manually",
				config: "Configuration",
				sessionLabel: "Target conversation",
				sessionAuto: "Follow the current conversation (auto)",
				sessionUntitled: "Untitled session",
				sessionRunning: "running",
				sessionCurrent: "current",
				sessionRefresh: "Refresh conversations",
				sessionEmpty: "No conversations available",
				sessionHint: "Questions are delivered to the selected conversation; Auto follows the one you have open.",
				autoAnswer: "Auto answer",
				silenceMs: "Silence threshold (ms)",
				hotkeyLabel: "Shortcut",
				clip: "Record a clip and transcribe",
				clipSeconds: "Seconds",
				clipRunning: "Recording",
				clipStopping: "Transcribing…",
				clipEmpty: "No speech recognized",
				clipInserted: "Written into the composer draft",
				clipManual: "The composer is not writable — text copied to the clipboard",
				clipFailed: "Recording or transcription failed",
				delivered: "Delivered",
				deliverFailed: "Delivery failed",
				clipInsertedFlag: "inserted",
				clipManualFlag: "insert failed",
				sidebarSection: "Sidebar transcript",
				sidebarHint: "History, re-answer and the listening switch live in the “Mock interview” tab of the right sidebar.",
				sidebarOpen: "Open the transcript panel in the sidebar",
				sidebarOpened: "Opened in the sidebar",
				sidebarUnavailable: "DSH-better-sidebar not found: history, re-answer and the listening switch stay in this panel.",
				tabTitle: "Mock interview",
				tabDesc: "Transcript, re-answer and listening controls",
				minutes: "m",
				seconds: "s",
			},
		};

		const css = `
/* Both seats (the left main panel and the better-sidebar tab) can hold more
   rows than the viewport: the whole surface scrolls so every section stays
   reachable. height/max-height keep it inside a bounded parent; when the
   parent is auto-height it simply grows and the parent scrolls instead. */
.dsh-interview__root {
  box-sizing: border-box;
  display: flex; flex-direction: column; gap: 10px; padding: 12px;
  font-size: 12px; line-height: 1.5; color: inherit;
  height: 100%; max-height: 100%; min-height: 0;
  overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-gutter: stable;
}
.dsh-interview__root::-webkit-scrollbar { width: 8px; height: 8px; }
.dsh-interview__root::-webkit-scrollbar-track { background: transparent; }
.dsh-interview__root::-webkit-scrollbar-thumb {
  border-radius: 4px; background: color-mix(in srgb, currentColor 22%, transparent);
}
.dsh-interview__root::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, currentColor 34%, transparent);
}
.dsh-interview__list::-webkit-scrollbar { width: 8px; }
.dsh-interview__list::-webkit-scrollbar-track { background: transparent; }
.dsh-interview__list::-webkit-scrollbar-thumb {
  border-radius: 4px; background: color-mix(in srgb, currentColor 22%, transparent);
}
.dsh-interview__list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, currentColor 34%, transparent);
}
/* Sections must keep their natural height instead of being squashed by the
   column flex layout once the content overflows. */
.dsh-interview__section {
  flex: 0 0 auto;
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 8px;
}
.dsh-interview__section-title { font-size: 11px; font-weight: 600; opacity: 0.6; letter-spacing: 0.04em; }
.dsh-interview__header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-interview__title { font-size: 13px; font-weight: 600; }
.dsh-interview__state { display: inline-flex; align-items: center; gap: 6px; opacity: 0.85; }
.dsh-interview__dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: currentColor; opacity: 0.35;
}
.dsh-interview__dot--live { background: #e5484d; opacity: 1; animation: dsh-interview-pulse 1s ease-in-out infinite; }
.dsh-interview__dot--offline { background: #f5a623; opacity: 1; }
@keyframes dsh-interview-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.dsh-interview__button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 26px; padding: 0 10px; border-radius: 7px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px; line-height: 1;
}
.dsh-interview__button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-interview__button[disabled] { opacity: 0.5; cursor: default; }
.dsh-interview__button--danger { border-color: #e5484d; color: #e5484d; }
.dsh-interview__button--small { height: 22px; padding: 0 8px; font-size: 11px; }
.dsh-interview__field { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-interview__field--column { flex-direction: column; align-items: stretch; }
.dsh-interview__label { opacity: 0.7; }
.dsh-interview__goal { opacity: 0.85; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dsh-interview__goal--none { color: #f5a623; }
.dsh-interview__select, .dsh-interview__input {
  font: inherit; color: inherit; background: transparent; min-width: 0;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 6px; padding: 2px 4px;
}
.dsh-interview__select { max-width: 240px; }
.dsh-interview__input--number { width: 64px; }
.dsh-interview__meter {
  position: relative; height: 8px; border-radius: 4px; overflow: hidden;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.dsh-interview__meter-fill {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  background: #30a46c; transition: width 120ms linear;
}
.dsh-interview__meter-fill--hot { background: #e5484d; }
.dsh-interview__mono { font-variant-numeric: tabular-nums; opacity: 0.7; }
.dsh-interview__last-text { margin: 0; overflow-wrap: anywhere; }
.dsh-interview__list {
  display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none;
  /* The transcript grows without bound: cap it so the controls above stay in
     view, and let this list scroll on its own. */
  max-height: 46vh; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin; padding-right: 2px;
}
.dsh-interview__segment {
  display: flex; flex-direction: column; gap: 4px; padding: 6px 8px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 6px;
}
.dsh-interview__segment-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; opacity: 0.75; font-variant-numeric: tabular-nums; }
.dsh-interview__segment-text { margin: 0; overflow-wrap: anywhere; }
.dsh-interview__segment-actions { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.dsh-interview__badge {
  padding: 1px 6px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent); opacity: 0.75;
}
.dsh-interview__badge--ok { color: #30a46c; border-color: #30a46c; opacity: 1; }
.dsh-interview__hint { font-size: 11px; opacity: 0.7; }
.dsh-interview__hint--error { color: #e5484d; opacity: 1; }
.dsh-interview__hint--busy { color: #f5a623; opacity: 1; }
.dsh-interview__hint--ok { color: #30a46c; opacity: 1; }
.dsh-interview__empty { opacity: 0.6; }
.dsh-interview__icon { display: inline-flex; align-items: center; justify-content: center; position: relative; }
.dsh-interview__icon-dot {
  position: absolute; right: -1px; top: -1px; width: 6px; height: 6px; border-radius: 50%;
  background: #e5484d; animation: dsh-interview-pulse 1s ease-in-out infinite;
}
`;

		// Captured in apply(). Components that render outside this plugin's own
		// props chain (the better-sidebar tab gets {ctx, store, scope, tab,
		// visible}) read the optional service and the namespace-bound translator
		// from here instead of re-deriving them per render.
		let pluginCtx = null;
		let translateSeat = null;

		function label(t, key) {
			if (typeof t === "function") {
				try {
					const value = t(key);
					if (typeof value === "string" && value !== "" && value !== key) return value;
				} catch {
					/* fall through to the local dictionary */
				}
			}
			return strings.en[key] ?? key;
		}

		/**
		 * The optional DSH-better-sidebar client service. Absent — or not loaded
		 * yet — is a normal state, not an error: the plugin then keeps its full
		 * left panel and registers no tab.
		 */
		function betterSidebar(ctx = pluginCtx) {
			// `ctx.get(name)` is the cordis accessor the owning bundle uses itself
			// (`ctx.get("betterSidebar")`); `ctx.betterSidebar` is the documented
			// property form. Try both, and treat "not loaded yet" as a normal state:
			// the registration effect polls for a while.
			const candidates = [];
			try {
				if (typeof ctx?.get === "function") candidates.push(ctx.get("betterSidebar"));
			} catch {
				/* this DSH profile does not provide the service */
			}
			try {
				candidates.push(ctx?.betterSidebar);
			} catch {
				/* this DSH profile does not provide the service */
			}
			for (const service of candidates) {
				if (service !== null && service !== undefined && typeof service.registerTab === "function") return service;
			}
			return null;
		}

		/** `openTab` takes an optional scope; an empty session id means "current". */
		function sidebarScope(sessionId) {
			return typeof sessionId === "string" && sessionId !== "" ? { sessionId } : null;
		}

		/** Reveal (or focus) the transcript tab. False when the service is away. */
		function openTranscriptTab(sessionId) {
			const service = betterSidebar();
			if (service === null || typeof service.openTab !== "function") return false;
			const seed = { type: TAB_ID, title: label(translateSeat, "tabTitle") };
			try {
				const scope = sidebarScope(sessionId);
				if (scope === null) service.openTab(seed);
				else service.openTab(seed, scope);
				return true;
			} catch (failure) {
				reportClientError("openTab: " + errorText(failure));
				return false;
			}
		}

		/** Register the transcript tab type once; null while the service is away. */
		let duplicateReported = false;
		function registerTranscriptTab() {
			const service = betterSidebar();
			if (service === null) return null;
			try {
				const stop = service.registerTab({
					id: TAB_ID,
					title: () => label(translateSeat, "tabTitle"),
					description: () => label(translateSeat, "tabDesc"),
					icon: (size) => h(InterviewIcon, { size, active: false }),
					order: TAB_ORDER,
					single: true,
					component: InterviewTranscriptTab,
				});
				return typeof stop === "function" ? stop : () => {};
			} catch (failure) {
				// A hot reload can race its own disposer for a moment; keep the same id
				// and let the poll retry — but say so once, and never take the whole
				// client half down with it.
				if (!duplicateReported) {
					duplicateReported = true;
					reportClientError("registerTab: " + errorText(failure));
				}
				return null;
			}
		}

		async function call(prefix, path, body) {
			const init = body === undefined
				? { method: "GET", headers: { accept: "application/json" } }
				: {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(body),
				};
			const response = await fetch(prefix + path, { ...init, cache: "no-store" });
			const text = await response.text();
			let payload = null;
			if (text !== "") {
				try {
					payload = JSON.parse(text);
				} catch {
					payload = null;
				}
			}
			if (!response.ok || payload === null || payload.ok !== true) {
				const message = payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}

		const interview = (path, body) => call(PREFIX, path, body);
		const systemAudio = (path, body) => call(AUDIO, path, body);
		const errorText = (failure) => (failure instanceof Error ? failure.message : String(failure));

		/**
		 * Write text into the composer draft through the host-provided
		 * `inputActions` face. Same contract the composer row used before this
		 * control moved into the sidebar panel.
		 */
		function insertIntoDraft(inputActions, text) {
			if (text === "" || !inputActions || typeof inputActions.insertText !== "function") return false;
			try {
				const span = typeof inputActions.captureInsertion === "function" ? inputActions.captureInsertion() : undefined;
				return inputActions.insertText(text, span) !== false;
			} catch {
				return false;
			}
		}

		function clamp(value, min, max) {
			if (!Number.isFinite(value)) return min;
			return Math.min(max, Math.max(min, value));
		}

		/** "session-1a2b3c4d…" → "1a2b3c4d…"，用于没有标题的会话行。 */
		function shortSession(sessionId) {
			const text = String(sessionId ?? "");
			const body = text.startsWith("session-") ? text.slice("session-".length) : text;
			return body.length > 8 ? body.slice(0, 8) + "…" : body;
		}

		/** 会话下拉框里一行显示什么：标题优先，没有标题就用短 id。 */
		function sessionOptionLabel(item, t) {
			const title = typeof item?.title === "string" && item.title !== "" ? item.title : "";
			const head = title !== "" ? title : label(t, "sessionUntitled") + " " + shortSession(item?.sessionId);
			const flags = [];
			if (item?.current === true) flags.push(label(t, "sessionCurrent"));
			if (item?.running === true) flags.push(label(t, "sessionRunning"));
			return flags.length === 0 ? head : head + " · " + flags.join(" · ");
		}

		/**
		 * Best-effort read of the "current session" from whatever the owner share
		 * happens to expose. The `main` slot is a global panel (it does NOT bind a
		 * session), so the panel keeps its own notion of the delivery target and
		 * degrades to "no sessionId" — the host then falls back to the most recent
		 * session. Never throws: it only reads plain fields, never owner hooks.
		 */
		function currentSessionId(props) {
			const read = (value) => {
				if (typeof value === "string" && value !== "") return value;
				if (value === null || typeof value !== "object") return "";
				const candidates = [value.sessionId, value.id, value.current, value.active];
				for (const candidate of candidates) {
					if (typeof candidate === "string" && candidate !== "") return candidate;
				}
				return "";
			};
			// Deliberately hook-free. The owner props are NOT stable enough to call
			// hooks from — a hook that is reachable on one render and skipped on the
			// next is exactly React error #311 (fewer hooks than expected), which is
			// what made this panel render blank. The host resolves the real delivery
			// target anyway, so a plain field lookup is all the panel needs.
			try {
				if (typeof props?.sessionId === "string" && props.sessionId !== "") return props.sessionId;
				if (typeof props?.activeSessionId === "string" && props.activeSessionId !== "") return props.activeSessionId;
				if (typeof props?.session?.sessionId === "string" && props.session.sessionId !== "") return props.session.sessionId;
				if (props?.session !== undefined && props?.session !== null && typeof props.session !== "function") return read(props.session);
			} catch {
				return "";
			}
			return "";
		}

		function formatClock(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		/**
		 * Sidebar icon. ownerProps only carries `{ size, active }`; the button,
		 * label and tooltip stay owned by the shell, so this draws the mark plus a
		 * pulsing red dot while the host reports `state: 'listening'`.
		 */
		function InterviewIcon(props) {
			const size = typeof props?.size === "number" && props.size > 0 ? props.size : 16;
			const active = props?.active === true;
			const listening = props?.listening === true || props?.live === true;
			const normalOpacity = active ? 1 : 0.72;
			return h("span", {
				className: "dsh-interview__icon",
				style: { width: `${size}px`, height: `${size}px` },
				"data-dsh-plugin": "dsh-interview-mode",
				"data-dsh-part": "sidebar-icon",
			}, [
				h("svg", {
					key: "mark",
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					opacity: normalOpacity,
					"aria-hidden": "true",
				}, [
					// A chat bubble carrying a question mark — the interview mark.
					h("path", {
						key: "bubble",
						d: "M21 12a8 8 0 0 1-8 8H8l-4 3v-4.6A8 8 0 1 1 21 12Z",
					}),
					h("path", { key: "q-stem", d: "M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.4" }),
					h("path", { key: "q-dot", d: "M12 16.2h.01" }),
				]),
				listening
					? h("span", { key: "dot", className: "dsh-interview__icon-dot", "aria-hidden": "true" })
					: null,
			]);
		}

		/** 客户端异常留痕：面板边界负责显示，控制台负责留下可搜的记录。 */
		function reportClientError(text) {
			try {
				console.error("[dsh-interview-mode] " + String(text));
			} catch {
				/* 控制台不可用也不影响面板上的显示 */
			}
		}

		/**
		 * 面板壳：任何渲染期异常都会显示成面板里的文字，而不是留一块空白。
		 * 之前面板一崩就是纯空白，连线索都没有。
		 */
		class PanelBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error) {
				reportClientError(error instanceof Error ? error.message : String(error));
			}

			render() {
				const { error } = this.state;
				if (error === null) return this.props.children;
				const message = error instanceof Error ? error.message : String(error);
				return h("div", {
					className: "dsh-interview__root",
					"data-dsh-plugin": "dsh-interview-mode",
					"data-dsh-part": "main-panel-error",
				}, [
					h("div", { key: "title", className: "dsh-interview__title" }, "模拟面试面板加载失败"),
					h("div", { key: "message", className: "dsh-interview__hint dsh-interview__hint--error" }, message),
					h("div", { key: "hint", className: "dsh-interview__hint" }, "这行错误已同时回显到宿主状态，便于自动诊断。"),
				]);
			}
		}

		/**
		 * The whole sidebar panel. Global (session-free) seat: it owns its polling,
		 * its hotkey and its own notion of the delivery target, and every host call
		 * degrades quietly to an "offline" state when the host half is absent.
		 */
		function InterviewPanelInner(props) {
			// Read once through the same path every render so the hook count stays
			// stable even when the owner share carries no session hook at all.
			let sessionId = "";
			try {
				sessionId = currentSessionId(props);
			} catch {
				sessionId = "";
			}
			// The seat translator when the host passes one, else the namespace-bound
			// one captured in apply() (the better-sidebar tab carries no `t`).
			const t = props?.t ?? translateSeat;
			// 'full' = everything in one panel (no better-sidebar, or the tab seat);
			// 'settings' = the left panel with better-sidebar installed: settings
			// only, because history/re-answer/start-stop live in the tab now;
			// 'tab' = the right-sidebar transcript surface itself.
			const sidebarSeat = betterSidebar();
			const variant = props?.variant === "tab"
				? "tab"
				: props?.variant === "settings" && sidebarSeat !== null ? "settings" : "full";

			const [status, setStatus] = React.useState(null);
			const [offline, setOffline] = React.useState(false);
			const [error, setError] = React.useState("");
			const [note, setNote] = React.useState("");
			const [noteKind, setNoteKind] = React.useState("hint");
			const [busy, setBusy] = React.useState(false);
			const [devices, setDevices] = React.useState([]);
			const [deviceId, setDeviceId] = React.useState("");
			const [speech, setSpeech] = React.useState(null);
			const [autoAnswer, setAutoAnswer] = React.useState(true);
			const [silenceDraft, setSilenceDraft] = React.useState("");
			const [clipSeconds, setClipSeconds] = React.useState(String(DEFAULT_CLIP_SECONDS));
			const [clipPhase, setClipPhase] = React.useState("idle");
			const [clipNote, setClipNote] = React.useState("");
			const cfgTimer = React.useRef(null);
			const devicesLoaded = React.useRef(false);
			const settingsSeeded = React.useRef(false);
			const captureId = React.useRef(null);
			const captureBusy = React.useRef(false);
			// 「选择对话」：会话清单来自宿主 /interview/sessions（sessionController.list），
			// targetSessionId 为 '' 表示跟随当前会话。
			const [sessions, setSessions] = React.useState([]);
			const [targetSessionId, setTargetSessionId] = React.useState("");
			const [sessionNote, setSessionNote] = React.useState("");
			const sessionsLoaded = React.useRef(false);

			const announce = React.useCallback((text, kind) => {
				setNote(text);
				setNoteKind(kind ?? "hint");
			}, []);

			const applyStatus = React.useCallback((payload) => {
				setStatus(payload);
				setOffline(false);
				const settings = payload?.settings;
				if (settingsSeeded.current !== true && settings && typeof settings === "object") {
					settingsSeeded.current = true;
					setAutoAnswer(settings.autoAnswer !== false);
					if (typeof settings.targetSessionId === "string") setTargetSessionId(settings.targetSessionId);
					if (typeof settings.silenceMs === "number") setSilenceDraft(String(settings.silenceMs));
				}
			}, []);

			// Live status: one interval for the whole mounted lifetime, silent on
			// failure (the UI shows 离线 instead of an error wall).
			React.useEffect(() => {
				let stopped = false;
				const tick = async () => {
					try {
						const payload = await interview("/status");
						if (stopped) return;
						applyStatus(payload);
					} catch {
						if (stopped) return;
						setOffline(true);
					}
				};
				const timer = setInterval(() => void tick(), STATUS_POLL_MS);
				void tick();
				return () => {
					stopped = true;
					clearInterval(timer);
				};
			}, [applyStatus]);

			const loadDevices = React.useCallback(async () => {
				try {
					const payload = await interview("/devices");
					const list = Array.isArray(payload.devices) ? payload.devices : [];
					setDevices(list);
					setSpeech(payload.speech ?? null);
					const preferred = typeof payload.default === "string" && payload.default !== ""
						? payload.default
						: (list.find((item) => item?.default === true)?.id ?? "");
					setDeviceId((current) => {
						if (typeof current === "string" && current !== "" && list.some((item) => item?.id === current)) return current;
						return typeof preferred === "string" ? preferred : "";
					});
				} catch (failure) {
					announce(errorText(failure), "error");
				}
			}, [announce]);

			React.useEffect(() => {
				if (devicesLoaded.current === true) return undefined;
				devicesLoaded.current = true;
				void loadDevices();
				return undefined;
			}, [loadDevices]);

			// 选择对话：进面板拉一次会话清单；失败只提示，不打断轮询。
			const loadSessions = React.useCallback(async () => {
				try {
					const payload = await interview("/sessions");
					setSessions(Array.isArray(payload?.items) ? payload.items : []);
					setSessionNote(typeof payload?.error === "string" ? payload.error : "");
				} catch (failure) {
					setSessionNote(errorText(failure));
				}
			}, []);

			React.useEffect(() => {
				if (sessionsLoaded.current === true) return undefined;
				sessionsLoaded.current = true;
				void loadSessions();
				return undefined;
			}, [loadSessions]);

			const start = React.useCallback(async () => {
				setBusy(true);
				announce("");
				try {
					const request = {};
					if (typeof deviceId === "string" && deviceId !== "" && deviceId !== CAPTURE_DEVICE) request.deviceId = deviceId;
					if (sessionId !== "") request.sessionId = sessionId;
					await interview("/start", request);
					// Show the transcript where it is read. `single: true` means a
					// second start only re-focuses the existing tab.
					if (AUTO_OPEN_TAB) openTranscriptTab(sessionId);
				} catch (failure) {
					announce(errorText(failure), "error");
				} finally {
					setBusy(false);
				}
			}, [announce, deviceId, sessionId]);

			const stop = React.useCallback(async () => {
				setBusy(true);
				announce("");
				try {
					await interview("/stop");
				} catch (failure) {
					announce(errorText(failure), "error");
				} finally {
					setBusy(false);
				}
			}, [announce]);

			const answerLast = React.useCallback(async () => {
				try {
					const result = await interview("/answer-last", sessionId === "" ? {} : { sessionId });
					const delivered = result.delivered === true;
					const text = typeof result.text === "string" ? result.text : "";
					announce(
						(delivered ? label(t, "delivered") : label(t, "deliverFailed")) + (text === "" ? "" : "：" + text),
						delivered ? "ok" : "error",
					);
				} catch (failure) {
					announce(errorText(failure), "error");
				}
			}, [announce, sessionId, t]);

			// In-app hotkey Ctrl+Shift+I → force an answer for the latest buffer.
			// Registered on the document and removed on unmount.
			React.useEffect(() => {
				if (typeof document?.addEventListener !== "function") return undefined;
				const onKeyDown = (event) => {
					if (event?.defaultPrevented) return;
					if (event?.ctrlKey !== true || event?.shiftKey !== true) return;
					if (event?.altKey === true || event?.metaKey === true) return;
					if (typeof event?.key !== "string" || event.key.toLowerCase() !== HOTKEY_KEY) return;
					if (typeof event.preventDefault === "function") event.preventDefault();
					void answerLast();
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [answerLast]);

			// Config writes are debounced so typing in the ms field is one POST.
			const pushConfig = React.useCallback((patch) => {
				if (cfgTimer.current !== null) clearTimeout(cfgTimer.current);
				cfgTimer.current = setTimeout(() => {
					cfgTimer.current = null;
					void interview("/config", patch)
						.then((payload) => {
							const settings = payload?.settings;
							if (settings && typeof settings === "object") {
								settingsSeeded.current = true;
								setAutoAnswer(settings.autoAnswer !== false);
								if (typeof settings.targetSessionId === "string") setTargetSessionId(settings.targetSessionId);
								if (typeof settings.silenceMs === "number") setSilenceDraft(String(settings.silenceMs));
							}
						})
						.catch((failure) => announce(errorText(failure), "error"));
				}, CONFIG_DEBOUNCE_MS);
			}, [announce]);

			React.useEffect(() => () => {
				if (cfgTimer.current !== null) clearTimeout(cfgTimer.current);
			}, []);

			// --- migrated "record a clip and transcribe" flow ------------------
			// /system-audio/start → /system-audio/status?id= → /system-audio/stop,
			// then the text goes into the composer draft via inputActions.
			React.useEffect(() => () => {
				const id = captureId.current;
				if (id === null) return;
				captureId.current = null;
				void systemAudio(`/cancel?id=${encodeURIComponent(id)}`).catch(() => {});
			}, []);

			const finishClip = React.useCallback(async (id) => {
				captureBusy.current = true;
				setClipPhase("stopping");
				try {
					const result = await systemAudio("/stop", { id });
					if (captureId.current === id) captureId.current = null;
					const text = typeof result.text === "string" ? result.text : "";
					if (text === "") {
						setClipNote(label(t, "clipEmpty"));
					} else if (insertIntoDraft(props?.inputActions, text)) {
						setClipNote(label(t, "clipInserted"));
					} else {
						let copiedOk = false;
						try {
							await navigator.clipboard.writeText(text);
							copiedOk = true;
						} catch {
							copiedOk = false;
						}
						setClipNote(copiedOk ? label(t, "clipManual") : label(t, "cloneFailed"));
					}
					setClipPhase("idle");
				} catch (failure) {
					setClipNote(label(t, "clipFailed") + "：" + errorText(failure));
					setClipPhase("idle");
				} finally {
					captureBusy.current = false;
				}
			}, [props?.inputActions, t]);

			React.useEffect(() => {
				if (clipPhase !== "recording") return undefined;
				let stopped = false;
				const tick = async () => {
					const id = captureId.current;
					if (id === null || stopped) return;
					try {
						const statusPayload = await systemAudio(`/status?id=${encodeURIComponent(id)}`);
						if (stopped) return;
						if (statusPayload.state === "stopped" && !captureBusy.current) {
							stopped = true;
							void finishClip(id);
						}
					} catch (failure) {
						if (stopped) return;
						stopped = true;
						setClipNote(label(t, "clipFailed") + "：" + errorText(failure));
						setClipPhase("idle");
					}
				};
				const timer = setInterval(() => void tick(), CAPTURE_POLL_MS);
				void tick();
				return () => {
					stopped = true;
					clearInterval(timer);
				};
			}, [clipPhase, finishClip, t]);

			const startClip = React.useCallback(async () => {
				const seconds = clamp(Number.parseInt(clipSeconds, 10), 1, CAPTURE_MAX_SECONDS);
				captureBusy.current = true;
				setClipNote("");
				setClipPhase("starting");
				try {
					const started = await systemAudio("/start", { seconds });
					captureId.current = started.id;
					setClipPhase("recording");
				} catch (failure) {
					setClipNote(label(t, "clipFailed") + "：" + errorText(failure));
					setClipPhase("idle");
				} finally {
					captureBusy.current = false;
				}
			}, [clipSeconds, t]);

			const stopClip = React.useCallback(() => {
				const id = captureId.current;
				if (id === null) return;
				void finishClip(id);
			}, [finishClip]);

			const copy = React.useCallback(async (text) => {
				try {
					await navigator.clipboard.writeText(text);
					announce(label(t, "copied"), "ok");
				} catch {
					announce(label(t, "cloneFailed"), "error");
				}
			}, [announce, t]);

			// Left-panel affordance for the transcript tab. Harmless when the tab is
			// already open: `single: true` focuses it instead of opening a second one.
			const revealSidebarTab = React.useCallback(() => {
				const opened = openTranscriptTab(sessionId);
				announce(opened ? label(t, "sidebarOpened") : label(t, "sidebarUnavailable"), opened ? "ok" : "error");
			}, [announce, sessionId, t]);

			// --- derived view ---------------------------------------------------
			const state = status?.state === "listening" ? "listening" : status?.state === "idle" ? "idle" : status?.state ?? "idle";
			const listening = state === "listening";
			const level = status?.level ?? null;
			const rms = typeof level?.rms === "number" && Number.isFinite(level.rms) ? level.rms : 0;
			const ratio = Math.min(1, Math.max(0, rms));
			const segments = Array.isArray(status?.segments) ? status.segments.slice(-40).reverse() : [];
			const deliveredCount = typeof status?.delivered === "number" ? status.delivered : null;
			const errors = typeof status?.errors === "number" ? status.errors : null;
			const lastText = typeof status?.lastText === "string" ? status.lastText : "";
			const speechReady = speech !== null && speech !== undefined && speech.available === true;
			const clipPending = clipPhase === "starting" || clipPhase === "stopping";
			const stateLabel = offline
				? label(t, "stateOffline")
				: listening ? label(t, "stateListening") : label(t, "stateIdle");

			const dotClass = "dsh-interview__dot"
				+ (offline ? " dsh-interview__dot--offline" : listening ? " dsh-interview__dot--live" : "");

			const header = h("div", { key: "header", className: "dsh-interview__header" }, [
				h("span", { key: "title", className: "dsh-interview__title" }, label(t, "panelTitle")),
				h("span", { key: "state", className: "dsh-interview__state" }, [
					h("span", { key: "dot", className: dotClass, "aria-hidden": "true" }),
					h("span", { key: "text" }, stateLabel),
				]),
				h("button", {
					key: "toggle",
					type: "button",
					className: "dsh-interview__button" + (listening ? " dsh-interview__button--danger" : ""),
					disabled: busy,
					onClick: () => void (listening ? stop() : start()),
				}, listening ? label(t, "stop") : label(t, "start")),
			]);

			// Settings-only header: same state readout, no listening switch (that
			// moved to the transcript tab).
			const headerCompact = h("div", { key: "header", className: "dsh-interview__header" }, [
				h("span", { key: "title", className: "dsh-interview__title" }, label(t, "panelTitle")),
				h("span", { key: "state", className: "dsh-interview__state" }, [
					h("span", { key: "dot", className: dotClass, "aria-hidden": "true" }),
					h("span", { key: "text" }, stateLabel),
				]),
			]);

			// 目标会话显示：选了「目标对话」就显示它，否则跟随当前会话。
			const targetItem = targetSessionId === ""
				? null
				: sessions.find((item) => item?.sessionId === targetSessionId) ?? null;
			const goalText = targetSessionId !== ""
				? (targetItem === null ? targetSessionId : sessionOptionLabel(targetItem, t))
				: (sessionId === "" ? label(t, "goalNone") : sessionId);
			const goalLine = h("div", { key: "goal", className: "dsh-interview__field" }, [
				h("span", { key: "label", className: "dsh-interview__label" }, label(t, "goal") + "："),
				h("span", {
					key: "value",
					className: "dsh-interview__goal" + (targetSessionId === "" && sessionId === "" ? " dsh-interview__goal--none" : ""),
				}, goalText),
			]);

			const notes = [];
			if (offline) notes.push(h("span", { key: "offline", className: "dsh-interview__hint dsh-interview__hint--error" }, label(t, "stateOffline")));
			if (error !== "") notes.push(h("span", { key: "error", className: "dsh-interview__hint dsh-interview__hint--error" }, error));
			if (note !== "") notes.push(h("span", {
				key: "note",
				className: "dsh-interview__hint" + (noteKind === "error" ? " dsh-interview__hint--error" : noteKind === "ok" ? " dsh-interview__hint--ok" : ""),
			}, note));

			const deviceSection = h("div", { key: "device", className: "dsh-interview__section" }, [
				h("span", { key: "title", className: "dsh-interview__section-title" }, label(t, "deviceSection")),
				h("div", { key: "row", className: "dsh-interview__field" }, [
					h("span", { key: "label", className: "dsh-interview__label" }, label(t, "device")),
					h("select", {
						key: "select",
						className: "dsh-interview__select",
						value: deviceId,
						disabled: listening,
						onChange: (event) => setDeviceId(typeof event?.target?.value === "string" ? event.target.value : ""),
					}, [
						h("option", { key: "default", value: CAPTURE_DEVICE }, label(t, "deviceDefault")),
					].concat(devices.map((item) => h("option", {
						key: String(item?.id ?? ""),
						value: String(item?.id ?? ""),
					}, (item?.default === true ? "★ " : "") + String(item?.name ?? item?.id ?? ""))))),
					h("button", {
						key: "refresh",
						type: "button",
						className: "dsh-interview__button dsh-interview__button--small",
						onClick: () => void loadDevices(),
					}, label(t, "deviceRefresh")),
				]),
				h("div", { key: "speech", className: "dsh-interview__field" }, [
					h("span", { key: "label", className: "dsh-interview__label" }, label(t, "speechReady") + "："),
					h("span", { key: "value" }, speech === null
						? label(t, "speechUnknown")
						: speechReady ? label(t, "speechReady") : label(t, "speechNotReady")),
				]),
			]);

			// Left panel: where the live surface went, plus the button that reveals
			// it. Rendered only in the settings variant (with the service available).
			const sidebarSection = h("div", { key: "sidebar", className: "dsh-interview__section" }, [
				h("span", { key: "title", className: "dsh-interview__section-title" }, label(t, "sidebarSection")),
				h("span", { key: "hint", className: "dsh-interview__hint" }, label(t, "sidebarHint")),
				h("button", {
					key: "open",
					type: "button",
					className: "dsh-interview__button",
					onClick: () => revealSidebarTab(),
				}, label(t, "sidebarOpen")),
			]);

			const liveSection = h("div", { key: "live", className: "dsh-interview__section" }, [
				h("div", { key: "head", className: "dsh-interview__field" }, [
					h("span", { key: "title", className: "dsh-interview__section-title" }, label(t, "live")),
					h("span", { key: "db", className: "dsh-interview__mono" },
						`${label(t, "level")} ${(rms * 100).toFixed(0)}%` + (typeof level?.db === "number" ? ` · ${level.db.toFixed(1)} dB` : "")),
					deliveredCount === null ? null : h("span", { key: "delivered", className: "dsh-interview__mono" }, `${label(t, "delivered")} ${deliveredCount}`),
					errors === null || errors === 0 ? null : h("span", { key: "errors", className: "dsh-interview__hint dsh-interview__hint--error" }, `errors ${errors}`),
				]),
				h("div", {
					key: "meter",
					className: "dsh-interview__meter",
					role: "meter",
					"aria-valuemin": 0,
					"aria-valuemax": 100,
					"aria-valuenow": Math.round(ratio * 100),
				}, h("span", {
					className: "dsh-interview__meter-fill" + (ratio > 0.85 ? " dsh-interview__meter-fill--hot" : ""),
					style: { width: `${Math.round(ratio * 100)}%` },
				})),
				h("div", { key: "last", className: "dsh-interview__field dsh-interview__field--column" }, [
					h("span", { key: "label", className: "dsh-interview__label" }, label(t, "lastText")),
					h("p", { key: "text", className: "dsh-interview__last-text" }, lastText === "" ? label(t, "lastTextEmpty") : lastText),
				]),
			]);

			const segmentNodes = segments.length === 0
				? [h("span", { key: "empty", className: "dsh-interview__empty" }, label(t, "segmentsEmpty"))]
				: segments.map((segment, index) => {
					const id = segment?.id ?? index;
					const text = typeof segment?.text === "string" ? segment.text : "";
					const delivered = segment?.delivered === true;
					return h("li", { key: String(id), className: "dsh-interview__segment" }, [
						h("div", { key: "head", className: "dsh-interview__segment-head" }, [
							h("span", { key: "time" }, formatClock(segment?.t) || String(id)),
							h("span", {
								key: "badge",
								className: "dsh-interview__badge" + (delivered ? " dsh-interview__badge--ok" : ""),
							}, delivered ? label(t, "segDelivered") : label(t, "segPending")),
							segment?.isQuestion === true ? h("span", { key: "q", className: "dsh-interview__badge" }, "Q") : null,
							typeof segment?.audioSeconds === "number"
								? h("span", { key: "sec", className: "dsh-interview__mono" }, `${segment.audioSeconds.toFixed(1)}s`)
								: null,
						]),
						h("p", { key: "text", className: "dsh-interview__segment-text" }, text),
						h("div", { key: "actions", className: "dsh-interview__segment-actions" }, [
							h("button", {
								key: "answer",
								type: "button",
								className: "dsh-interview__button dsh-interview__button--small",
								onClick: () => void answerLast(),
							}, label(t, "answer")),
							h("button", {
								key: "copy",
								type: "button",
								className: "dsh-interview__button dsh-interview__button--small",
								onClick: () => void copy(text),
							}, label(t, "copy")),
						]),
					]);
				});

			const segmentsSection = h("div", { key: "segments", className: "dsh-interview__section" }, [
				h("span", { key: "title", className: "dsh-interview__section-title" }, label(t, "segments")),
				h("ul", { key: "list", className: "dsh-interview__list" }, segmentNodes),
			]);

			const configSection = h("div", { key: "config", className: "dsh-interview__section" }, [
				h("span", { key: "title", className: "dsh-interview__section-title" }, label(t, "config")),
				// 选择对话：'' = 跟随当前会话；选中后所有提问都投递到那个对话。
				h("div", { key: "sessions", className: "dsh-interview__field" }, [
					h("span", { key: "label", className: "dsh-interview__label" }, label(t, "sessionLabel")),
					h("select", {
						key: "select",
						className: "dsh-interview__select",
						value: targetSessionId,
						onChange: (event) => {
							const next = typeof event?.target?.value === "string" ? event.target.value : "";
							setTargetSessionId(next);
							pushConfig({ targetSessionId: next });
						},
					}, [
						h("option", { key: "auto", value: "" }, label(t, "sessionAuto")),
					].concat(sessions.map((item) => h("option", {
						key: String(item?.sessionId ?? ""),
						value: String(item?.sessionId ?? ""),
					}, sessionOptionLabel(item, t))))),
					h("button", {
						key: "refresh",
						type: "button",
						className: "dsh-interview__button dsh-interview__button--small",
						onClick: () => void loadSessions(),
					}, label(t, "sessionRefresh")),
				]),
				h("span", {
					key: "sessions-hint",
					className: "dsh-interview__hint" + (sessionNote === "" ? "" : " dsh-interview__hint--error"),
				}, sessionNote === ""
					? label(t, "sessionHint")
					: sessionNote + "（" + label(t, "sessionHint") + "）"),
				h("label", { key: "auto", className: "dsh-interview__field" }, [
					h("input", {
						key: "box",
						type: "checkbox",
						checked: autoAnswer,
						onChange: (event) => {
							const next = event?.target?.checked === true;
							setAutoAnswer(next);
							pushConfig({ autoAnswer: next });
						},
					}),
					h("span", { key: "text" }, label(t, "autoAnswer")),
				]),
				h("label", { key: "silence", className: "dsh-interview__field" }, [
					h("span", { key: "text" }, label(t, "silenceMs")),
					h("input", {
						key: "input",
						className: "dsh-interview__input dsh-interview__input--number",
						type: "number",
						min: 100,
						max: 5000,
						step: 50,
						value: silenceDraft,
						onChange: (event) => {
							const next = typeof event?.target?.value === "string" ? event.target.value : "";
							setSilenceDraft(next);
							const parsed = Number.parseInt(next, 10);
							if (Number.isFinite(parsed)) pushConfig({ silenceMs: clamp(parsed, 100, 5000) });
						},
					}),
				]),
				h("div", { key: "hotkey", className: "dsh-interview__field" }, [
					h("span", { key: "label", className: "dsh-interview__label" }, label(t, "hotkeyLabel") + "："),
					h("span", { key: "value", className: "dsh-interview__mono" }, "Ctrl+Shift+I"),
				]),
			]);

			const clipSection = h("div", { key: "clip", className: "dsh-interview__section" }, [
				h("span", { key: "title", className: "dsh-interview__section-title" }, label(t, "clip")),
				h("div", { key: "row", className: "dsh-interview__field" }, [
					clipPhase === "idle" || clipPending
						? h("button", {
							key: "run",
							type: "button",
							className: "dsh-interview__button",
							disabled: clipPending,
							onClick: () => void startClip(),
						}, label(t, "clip"))
						: h("button", {
							key: "stop",
							type: "button",
							className: "dsh-interview__button dsh-interview__button--danger",
							onClick: () => stopClip(),
						}, label(t, "stop")),
					h("span", { key: "sec-label", className: "dsh-interview__label" }, label(t, "clipSeconds")),
					h("input", {
						key: "seconds",
						className: "dsh-interview__input dsh-interview__input--number",
						type: "number",
						min: 1,
						max: CAPTURE_MAX_SECONDS,
						value: clipSeconds,
						disabled: clipPhase !== "idle",
						onChange: (event) => setClipSeconds(typeof event?.target?.value === "string" ? event.target.value : ""),
					}),
					clipPhase === "recording"
						? h("span", { key: "phase", className: "dsh-interview__hint dsh-interview__hint--busy" }, label(t, "clipRunning"))
						: clipPending
							? h("span", { key: "phase", className: "dsh-interview__hint dsh-interview__hint--busy" }, label(t, "clipStopping"))
							: null,
				].filter((child) => child !== null)),
				clipNote === ""
					? null
					: h("span", {
						key: "note",
						className: "dsh-interview__hint" + (/失败|failed/i.test(clipNote) ? " dsh-interview__hint--error" : " dsh-interview__hint--ok"),
					}, clipNote),
			]);

			// Every section above is built on every render, so the hook order and the
			// element types never depend on the variant; only the assembled list does.
			const layouts = {
				full: [header, goalLine, deviceSection, liveSection, segmentsSection, configSection, clipSection],
				settings: [headerCompact, sidebarSection, deviceSection, configSection, clipSection],
				tab: [header, goalLine, liveSection, segmentsSection],
			};
			const children = layouts[variant].slice();
			if (notes.length > 0) children.push(h("div", { key: "notes", className: "dsh-interview__field" }, notes));
			return h("div", {
				className: "dsh-interview__root",
				"data-dsh-plugin": "dsh-interview-mode",
				"data-dsh-part": variant === "tab" ? "sidebar-tab-panel" : "main-panel",
				"data-dsh-variant": variant,
			}, children);
		}

		/** 面板外壳：渲染异常变成可见文字，而不是空白。 */
		function InterviewPanel(props) {
			// 'settings' resolves to 'full' inside when better-sidebar is absent.
			return h(PanelBoundary, null, h(InterviewPanelInner, { ...props, variant: "settings" }));
		}

		/**
		 * DSH-better-sidebar tab seat. Its props are { ctx, store, scope, tab,
		 * visible } — no `t` and no `inputActions` — so the session id comes from
		 * `scope` and labels come from the namespace-bound translator captured in
		 * apply(). Rendered only while the tab is open.
		 */
		function InterviewTranscriptTab(props) {
			const sessionId = typeof props?.scope?.sessionId === "string" ? props.scope.sessionId : "";
			return h(PanelBoundary, null, h(InterviewPanelInner, {
				variant: "tab",
				t: props?.t,
				sessionId,
			}));
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			pluginCtx = ctx;
			// Labels for seats the shell renders without a translator (the tab
			// descriptor's title/description). Read lazily, so registering the
			// dictionary below and binding here can be in either order.
			try {
				translateSeat = typeof ctx?.locale?.bind === "function" ? ctx.locale.bind(NS) : null;
			} catch {
				translateSeat = null;
			}
			ctx.effect(() => {
				if (typeof ctx.locale?.register === "function") return ctx.locale.register(NS, strings);
				return undefined;
			});
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-dsh-interview-mode", "");
				style.textContent = css;
				document.head.appendChild(style);
				return () => style.remove();
			});
			// 页面级兜底：React 边界管不到的异常（事件回调、异步任务）也回显一次，
			// 这样"点图标没反应/面板空白"不会变成无线索的悬案。
			ctx.effect(() => {
				if (typeof window?.addEventListener !== "function") return undefined;
				const onError = (event) => {
					const message = event?.error?.message ?? event?.message;
					if (typeof message === "string" && message !== "") reportClientError("window.onerror: " + message);
				};
				const onRejection = (event) => {
					const reason = event?.reason;
					const message = reason instanceof Error ? reason.message : String(reason ?? "");
					if (message !== "") reportClientError("unhandledrejection: " + message);
				};
				window.addEventListener("error", onError);
				window.addEventListener("unhandledrejection", onRejection);
				return () => {
					window.removeEventListener("error", onError);
					window.removeEventListener("unhandledrejection", onRejection);
				};
			});
			// Optional: the transcript tab inside DSH's right sidebar. The client
			// halves of two bundles can load in either order, so poll briefly when the
			// service is not up yet; a profile without the plugin installs nothing and
			// is not an error. The registration is owned by this effect and disposed
			// with the plugin (hot reload included).
			ctx.effect(() => {
				let stopTab = registerTranscriptTab();
				let timer = null;
				let tries = 0;
				if (stopTab === null) {
					timer = setInterval(() => {
						tries += 1;
						if (tries > SIDEBAR_PROBE_TRIES) {
							clearInterval(timer);
							timer = null;
							return;
						}
						stopTab = registerTranscriptTab();
						if (stopTab !== null) {
							clearInterval(timer);
							timer = null;
						}
					}, SIDEBAR_PROBE_MS);
				}
				return () => {
					if (timer !== null) clearInterval(timer);
					if (typeof stopTab === "function") {
						try {
							stopTab();
						} catch {
							/* already released by the service */
						}
					}
				};
			});

			// Sidebar-only placement. `main` is a keyed slot (key 'interview'),
			// `sidebar.panellist` is a list slot (id 'interview'); both are declared
			// by the shipped shell UI, so every registration must happen inside the
			// declared-slot callback — `slots.register` throws into an undeclared
			// slot. Nothing registers into `conversation.input.*`.
			ctx.slots.inject("main", () => {
				ctx.slots.inject("sidebar.panellist", () => {
					const stopPanel = ctx.slots.register({
						name: "main",
						key: ICON_ID,
						locale: NS,
					}, InterviewPanel);
					const stopIcon = ctx.slots.register({
						name: "sidebar.panellist",
						id: ICON_ID,
						order: 40,
						// The shell owns the button, so the label is i18n-resolved at
						// click time. Tolerates both shell styles: a translator passed
						// as an argument, or no argument (local dictionary fallback).
						label: (translate) => label(typeof translate === "function" ? translate : null, "title"),
						locale: NS,
					}, InterviewIcon);
					return () => {
						stopIcon?.();
						stopPanel?.();
					};
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
