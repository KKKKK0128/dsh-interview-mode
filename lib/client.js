// dsh-interview-mode — browser half.
//
// Hand-written in the client module format DSH expects (identical contract to
// dsh-system-audio/lib/client.js): this file only registers a factory, and the
// module body runs when the shell materializes it. It needs nothing beyond
// React and the plugin context, so there is no build step and no generated
// Typert artifact — capture, transcription, question judging and delivery all
// live in the host half behind /interview/* and /system-audio/*.
//
// UI placement (v1.1 of PLAN.md): the sidebar ONLY. Two seats are registered —
// `sidebar.panellist` (list, id 'interview') and `main` (keyed, key
// 'interview'). Nothing is registered into `conversation.input.*`; the
// composer is untouched by this plugin. The legacy "record a clip and
// transcribe" control that used to live in the composer row is re-hosted here
// as a panel button that writes into the current draft through the same
// `inputActions` contract.
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
				minutes: "m",
				seconds: "s",
			},
		};

		const css = `
.dsh-interview__root {
  display: flex; flex-direction: column; gap: 10px; padding: 12px;
  font-size: 12px; line-height: 1.5; color: inherit;
}
.dsh-interview__section {
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
.dsh-interview__list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
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
			const t = props?.t;

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

			const start = React.useCallback(async () => {
				setBusy(true);
				announce("");
				try {
					const request = {};
					if (typeof deviceId === "string" && deviceId !== "" && deviceId !== CAPTURE_DEVICE) request.deviceId = deviceId;
					if (sessionId !== "") request.sessionId = sessionId;
					await interview("/start", request);
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

			const goalLine = h("div", { key: "goal", className: "dsh-interview__field" }, [
				h("span", { key: "label", className: "dsh-interview__label" }, label(t, "goal") + "："),
				h("span", {
					key: "value",
					className: "dsh-interview__goal" + (sessionId === "" ? " dsh-interview__goal--none" : ""),
				}, sessionId === "" ? label(t, "goalNone") : sessionId),
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

			const children = [header, goalLine, deviceSection, liveSection, segmentsSection, configSection, clipSection];
			if (notes.length > 0) children.push(h("div", { key: "notes", className: "dsh-interview__field" }, notes));
			return h("div", {
				className: "dsh-interview__root",
				"data-dsh-plugin": "dsh-interview-mode",
				"data-dsh-part": "main-panel",
			}, children);
		}

		/** 面板外壳：渲染异常变成可见文字，而不是空白。 */
		function InterviewPanel(props) {
			return h(PanelBoundary, null, h(InterviewPanelInner, props));
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
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
