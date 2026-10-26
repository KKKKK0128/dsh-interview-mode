// Offline self-check for dsh-interview-mode's browser half.
//
// Loads lib/client.js through a fake `window.__ModuleLoader__` plus a minimal
// React stand-in, runs the returned `apply(ctx)` against a recording slot host,
// and asserts the placement contract from PLAN.md v1.2:
//
//   1. exactly two DSH slot registrations: `sidebar.panellist` (id 'interview')
//      and `main` (key 'interview');
//   2. NOTHING registered into `conversation.input.*`;
//   3. exactly one DSH-better-sidebar tab type ('dsh-interview-mode:transcript')
//      when that optional service is present, and none when it is absent —
//      where the left panel then falls back to the full surface;
//   4. dsh-system-audio's client.js no longer registers into
//      `conversation.input.left`.
//
// Run: node dsh-interview-mode/.test/client-check.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTERVIEW_CLIENT = path.resolve(HERE, "..", "lib", "client.js");
const SYSTEM_AUDIO_CLIENT = path.resolve(HERE, "..", "..", "dsh-system-audio", "lib", "client.js");

let failures = 0;
function check(name, ok, detail = "") {
	if (!ok) failures += 1;
	console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

/** Minimal React stand-in, good enough to typeof-check and to build nodes. */
function makeReact() {
	const records = { state: [], ref: [], order: [] };
	let cursor = 0;
	// The stand-in never re-renders, so a single render pass suffices.
	return {
		createElement(type, props, ...children) {
			return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
		},
		Fragment: Symbol("React.Fragment"),
		// lib/client.js declares an error boundary (`extends React.Component`), so
		// the stand-in needs the base class even though nothing here renders it.
		Component: class Component {
			constructor(props) {
				this.props = props ?? {};
				this.state = null;
			}
			setState(next) {
				const patch = typeof next === "function" ? next(this.state) : next;
				this.state = { ...(this.state ?? {}), ...(patch ?? {}) };
			}
		},
		useState(initial) {
			const at = cursor++;
			records.order.push(`state@${at}`);
			if (!(at in records.state)) records.state[at] = typeof initial === "function" ? initial() : initial;
			const setter = (next) => {
				records.state[at] = typeof next === "function" ? next(records.state[at]) : next;
			};
			return [records.state[at], setter];
		},
		useRef(initial) {
			const at = cursor++;
			records.order.push(`ref@${at}`);
			if (!(at in records.ref)) records.ref[at] = { current: initial };
			return records.ref[at];
		},
		useCallback(fn) {
			cursor += 1;
			records.order.push("callback");
			return fn;
		},
		useMemo(fn) {
			cursor += 1;
			records.order.push("memo");
			return fn();
		},
		useEffect() {
			cursor += 1;
			records.order.push("effect");
			return undefined;
		},
		useLayoutEffect() {
			cursor += 1;
			records.order.push("layout-effect");
			return undefined;
		},
		__records: records,
		reset() {
			cursor = 0;
		},
	};
}

/** Recording slot host exposing the exact surface the client halves use. */
function makeCtx(declaredSlots, options = {}) {
	const declared = new Set(declaredSlots);
	const ctx = {
		registrations: [],
		effects: [],
		declaredChecks: [],
		localeRegistrations: [],
		tabs: [],
		openTabCalls: [],
		locale: {
			register(namespace, table) {
				ctx.localeRegistrations.push({ namespace, table });
				return () => {};
			},
			// Untyped bind: the panel/tab labels resolve through it when the host
			// passes no translator.
			bind(namespace) {
				return (key) => `${namespace}.${key}`;
			},
		},
		effect(fn) {
			// The real slot host runs an effect body as soon as it is registered and
			// returns the disposer; do the same so locale/CSS wiring is observable.
			const dispose = fn();
			ctx.effects.push({ fn, dispose });
			return () => {
				if (typeof dispose === "function") dispose();
			};
		},
		slots: {
			inject(slotName, factory) {
				ctx.declaredChecks.push({ slotName, declared: declared.has(slotName) });
				if (!declared.has(slotName)) throw new Error(`slot '${slotName}' is not declared`);
				return factory();
			},
			register(options, component) {
				ctx.registrations.push({ options, component });
				return () => {};
			},
		},
	};
	// Optional DSH-better-sidebar client service. `{ betterSidebar: false }`
	// models a profile that does not have the plugin installed;
	// `betterSidebarChannel: 'get' | 'property'` models a host that exposes it
	// through only one of the two accessors the plugin tries.
	const service = options.betterSidebar === false ? null : {
		registerTab(descriptor) {
			if (ctx.tabs.some((tab) => tab.id === descriptor?.id)) {
				throw new Error(`[dsh-better-sidebar] tab type "${descriptor?.id}" already registered`);
			}
			ctx.tabs.push(descriptor);
			return () => {};
		},
		openTab(seed, scope) {
			ctx.openTabCalls.push({ seed, scope });
		},
	};
	ctx.get = (name) => {
		if (name !== "betterSidebar") return undefined;
		return options.betterSidebarChannel === "property" ? null : service;
	};
	if (options.betterSidebarChannel !== "get") ctx.betterSidebar = service;
	return ctx;
}

function makeFakeDom() {
	const listeners = [];
	const appended = [];
	return {
		listeners,
		appended,
		document: {
			head: { appendChild: (node) => appended.push(node) },
			body: { appendChild: (node) => appended.push(node) },
			createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
			addEventListener: (type, handler) => listeners.push({ type, handler }),
			removeEventListener: (type, handler) => {
				const at = listeners.findIndex((l) => l.type === type && l.handler === handler);
				if (at >= 0) listeners.splice(at, 1);
			},
		},
	};
}

/** Evaluate one client bundle against a fake window/document/fetch. */
async function loadClient(file, windowObject, dom, options = {}) {
	const source = await readFile(file, "utf8");
	const previousWindow = globalThis.window;
	const fetchCalls = options.fetchCalls ?? [];
	const timers = options.timers ?? [];
	globalThis.window = windowObject;
	try {
		const factory = new Function(
			"window",
			"document",
			"navigator",
			"fetch",
			"setInterval",
			"setTimeout",
			"clearInterval",
			"clearTimeout",
			`${source}\n//# sourceURL=${file.replace(/\\/g, "/")}`,
		);
		factory(
			windowObject,
			dom.document,
			{ clipboard: { writeText: async () => {} } },
			async (url, init) => {
				fetchCalls.push({ url: String(url), init });
				return { ok: true, status: 200, text: async () => '{"ok":true}' };
			},
			() => 0,
			(fn, ms) => {
				timers.push({ fn, ms });
				return timers.length;
			},
			() => {},
			() => {},
		);
	} finally {
		globalThis.window = previousWindow;
	}
	return { fetchCalls, timers };
}

const declaredSlots = ["main", "sidebar.panellist", "conversation.input.left", "conversation.input.right", "conversation.input.toolbar"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadBundle(file, optionalRequires = [], options = {}) {
	const loaded = [];
	const dom = makeFakeDom();
	const windowObject = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } };
	const hooks = await loadClient(file, windowObject, dom, options);
	return { loaded, dom, windowObject, file, optionalRequires, ...hooks };
}

// ---------------------------------------------------------------- interview
{
	console.log("# dsh-interview-mode/lib/client.js");
	const source = await readFile(INTERVIEW_CLIENT, "utf8");
	const fetchCalls = [];
	const timers = [];
	const bundle = await loadBundle(INTERVIEW_CLIENT, [], { fetchCalls, timers });
	check("module registers exactly one loader entry", bundle.loaded.length === 1, `got ${bundle.loaded.length}`);
	const entry = bundle.loaded[0] ?? {};
	check("loader id is 'dsh-interview-mode'", entry.id === "dsh-interview-mode", String(entry.id));
	check("factory is a function", typeof entry.factory === "function");

	const react = makeReact();
	const moduleExports = entry.factory((id) => {
		if (id === "react") return react;
		throw new Error(`unexpected require(${id})`);
	});
	check("exports.apply is a function", typeof moduleExports?.apply === "function");
	check(
		"exports.inject deep-equals ['slots','locale']",
		JSON.stringify(moduleExports?.inject) === JSON.stringify(["slots", "locale"]),
		JSON.stringify(moduleExports?.inject),
	);

	const ctx = makeCtx(declaredSlots);
	moduleExports.apply(ctx);

	const names = ctx.registrations.map((r) => r.options?.name);
	check("exactly two slot registrations", ctx.registrations.length === 2, `got ${ctx.registrations.length}: ${JSON.stringify(names)}`);
	check(
		"every injected slot was declared by the shell",
		ctx.declaredChecks.length > 0 && ctx.declaredChecks.every((c) => c.declared === true),
		JSON.stringify(ctx.declaredChecks),
	);

	const panel = ctx.registrations.find((r) => r.options?.name === "sidebar.panellist");
	check("sidebar.panellist registered", panel !== undefined);
	check("sidebar.panellist id === 'interview'", panel?.options?.id === "interview", String(panel?.options?.id));
	check("sidebar.panellist order === 40", panel?.options?.order === 40, String(panel?.options?.order));
	check("sidebar.panellist label is a function", typeof panel?.options?.label === "function");
	check("sidebar.panellist label() returns a string", typeof panel?.options?.label?.() === "string", JSON.stringify(panel?.options?.label?.()));
	check("sidebar.panellist binds icon component", panel?.component?.name === "InterviewIcon", String(panel?.component?.name));

	const main = ctx.registrations.find((r) => r.options?.name === "main");
	check("main registered", main !== undefined);
	check("main key === 'interview'", main?.options?.key === "interview", String(main?.options?.key));
	check("main binds panel component", main?.component?.name === "InterviewPanel", String(main?.component?.name));

	// v1.2: the live surface (history / re-answer / start-stop) is a
	// DSH-better-sidebar tab type, while the left panel keeps the settings.
	const tab = ctx.tabs[0];
	check("exactly one better-sidebar tab type registered", ctx.tabs.length === 1, `got ${ctx.tabs.length}`);
	check(
		"tab id is 'dsh-interview-mode:transcript'",
		tab?.id === "dsh-interview-mode:transcript",
		String(tab?.id),
	);
	check("tab title is a function returning a string", typeof tab?.title === "function" && typeof tab.title() === "string", String(tab?.title?.()));
	check("tab description is a function returning a string", typeof tab?.description === "function" && typeof tab.description() === "string", String(tab?.description?.()));
	check("tab order === 120", tab?.order === 120, String(tab?.order));
	check("tab is single-instance", tab?.single === true, String(tab?.single));
	check("tab exposes an icon factory", typeof tab?.icon === "function");
	check("tab binds the transcript component", tab?.component?.name === "InterviewTranscriptTab", String(tab?.component?.name));

	let tabError = "";
	try {
		tab.component({ ctx, scope: { sessionId: "session-abc" }, tab: { id: "t1", type: tab.id }, visible: true });
		tab.component({ ctx, scope: {}, tab: { id: "t2", type: tab.id }, visible: false });
	} catch (failure) {
		tabError = String(failure?.message ?? failure);
	}
	check("tab component renders with and without a session scope", tabError === "", tabError);

	const inputRegistrations = ctx.registrations.filter((r) => String(r.options?.name ?? "").startsWith("conversation.input"));
	check(
		"no conversation.input.* registration",
		inputRegistrations.length === 0,
		JSON.stringify(inputRegistrations.map((r) => r.options?.name)),
	);
	check(
		"locale table registered for the plugin namespace",
		ctx.localeRegistrations.some((r) => r.namespace === "dsh-interview-mode"),
		JSON.stringify(ctx.localeRegistrations.map((r) => r.namespace)),
	);
	check("one CSS style element injected", bundle.dom.appended.length === 1, `got ${bundle.dom.appended.length}`);

	// Polling + teardown contract, asserted at source level because polling and
	// the keydown listener are wired in component effects (the React stand-in
	// above does not execute them).
	check("status polling interval is 700 ms", /STATUS_POLL_MS\s*=\s*700/.test(source));
	check("polling effect clears its interval on unmount", /clearInterval\(timer\)/.test(source));
	check("hotkey listens for document keydown", /document\.addEventListener\(\s*["']keydown["']/.test(source));
	check("hotkey listener is removed on unmount", /document\.removeEventListener\(\s*["']keydown["']/.test(source));
	check("hotkey is Ctrl+Shift+I", /HOTKEY_KEY\s*=\s*["']i["']/.test(source) && /ctrlKey\s*!==\s*true/.test(source));
	check("hotkey posts to /interview/answer-last", /\/answer-last/.test(source));
	check("answer-now hotkey is Ctrl+Shift+U", /HOTKEY_NOW_KEY\s*=\s*["']u["']/.test(source));
	check("answer-now hotkey posts to /interview/answer-now", /\/answer-now/.test(source));
	check("panel offers an answer-now control", /label\(t,\s*["']answerNow["']\)/.test(source));
	check("long-answer control posts to /interview/answer-long", /\/answer-long/.test(source));
	check("panel offers a long-answer control", /label\(t,\s*["']answerLong["']\)/.test(source));
	check("migrated clip flow hits /system-audio start/status/stop", /\/start/.test(source) && /\/status\?id=/.test(source) && /systemAudio\(\s*["']\/stop["']/.test(source));
	check("migrated clip flow writes through inputActions.insertText", /inputActions\.insertText\(/.test(source));

	// The panel must survive being rendered by a host that passes only { t } —
	// i.e. no session hook and no inputActions (a global sidebar seat).
	let renderError = "";
	try {
		main.component({ t: (k) => k });
	} catch (failure) {
		renderError = String(failure?.message ?? failure);
	}
	check("panel renders without a session hook or inputActions", renderError === "", renderError);

	// And with an owner share that does expose a session hook plus the composer
	// inputActions face the migrated record button writes through.
	let richError = "";
	try {
		main.component({
			t: (k) => k,
			useSessions: () => ({ current: "session-abc" }),
			inputActions: { insertText: () => true, captureInsertion: () => undefined },
		});
	} catch (failure) {
		richError = String(failure?.message ?? failure);
	}
	check("panel renders with a session hook and inputActions", richError === "", richError);

	const icon = panel.component;
	let iconError = "";
	try {
		icon({ size: 18, active: true });
		icon({ size: 18, active: false });
		icon({ size: 18, active: false, listening: true });
	} catch (failure) {
		iconError = String(failure?.message ?? failure);
	}
	check("icon renders for {size,active} with and without listening", iconError === "", iconError);

	// Source-level wiring that the React stand-in cannot observe: the optional
	// service lookup, the probing fallback and the auto-reveal on start.
	check("looks the optional betterSidebar service up defensively", /service !== null && service !== undefined/.test(source) && /typeof service\.registerTab === "function"/.test(source));
	check("registers the transcript tab type", /service\.registerTab\(\{/.test(source) && /id: TAB_ID/.test(source));
	check("probes for a late-arriving service", /SIDEBAR_PROBE_MS/.test(source) && /SIDEBAR_PROBE_TRIES/.test(source));
	check("disposes the tab registration with the plugin", /stopTab\(\)/.test(source));
	check("reveals the tab when listening starts", /AUTO_OPEN_TAB\) openTranscriptTab\(/.test(source));
	check("left panel carries the settings variant", /variant: "settings"/.test(source));
	check("tab seat renders the tab variant", /variant: "tab"/.test(source));
	check("tab surface is marked for inspection", /"data-dsh-part": variant === "tab" \? "sidebar-tab-panel"/.test(source));

	// v1.3 选择对话：设置面板可以把投递对象固定到某个对话。轮询与防抖都在 effect
	// 里，因此先做源码级断言，渲染级断言放在下面的 innerNode 段落。
	check("settings surface fetches the optional conversation list", /interview\(\s*["']\/sessions["']/.test(source));
	check("keeps the pinned conversation in state", /const \[targetSessionId, setTargetSessionId\] = React\.useState\(""\)/.test(source));
	check("pins the conversation through POST /interview/config", /pushConfig\(\{ targetSessionId: next \}\)/.test(source));
	check("offers a select bound to the pinned conversation", /value: targetSessionId,/.test(source) && /label\(t, "sessionAuto"\)/.test(source));
	check("supplies a readable fallback for untitled conversations", /function sessionOptionLabel\(/.test(source) && /function shortSession\(/.test(source) && /sessionUntitled/.test(source))

	// v1.4 英文识别：设置面板的识别语言下拉框（auto / zh / en）同样经 /interview/config 下发。
	check("keeps the recognition language in state", /const \[language, setLanguage\] = React\.useState\("auto"\)/.test(source));
	check("persists the recognition language through POST /interview/config", /pushConfig\(\{ language: next \}\)/.test(source));
	check(
		"offers a language select with auto / zh / en options",
		/value: language,/.test(source) && /label\(t, "languageAuto"\)/.test(source) && /value: "en"/.test(source),
	);

	// The seats wrap the real component in the error boundary, so descend one
	// level and render the inner component to inspect what it actually returns.
	const innerNode = (seatElement) => {
		const child = seatElement?.props?.children;
		return typeof child?.type === "function" ? child.type(child.props) : child;
	};
	const buttonsOf = (node, found = []) => {
		if (node === null || node === undefined || typeof node !== "object") return found;
		if (node.type === "button" && typeof node.props?.onClick === "function") found.push(node);
		const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
		for (const child of children) buttonsOf(child, found);
		return found;
	};

	// With the service present the left panel renders the settings variant and
	// its button reveals the tab in the scope of the open session. This runs
	// before the no-service case below, because the fallback apply() re-points the
	// module-level plugin context that `betterSidebar()` reads.
	let settingsError = "";
	try {
		const node = innerNode(main.component({ t: (k) => k, sessionId: "session-abc" }));
		if (node?.props?.["data-dsh-variant"] !== "settings") {
			settingsError = `variant=${String(node?.props?.["data-dsh-variant"])}`;
		} else {
			const buttons = buttonsOf(node);
			for (const button of buttons) {
				button.props.onClick();
				if (ctx.openTabCalls.length > 0) break;
			}
			const call = ctx.openTabCalls.at(-1);
			if (call === undefined) settingsError = "no button revealed the tab";
			else if (call.seed?.type !== "dsh-interview-mode:transcript") settingsError = `seed.type=${String(call.seed?.type)}`;
			else if (call.scope?.sessionId !== "session-abc") settingsError = `scope=${JSON.stringify(call.scope)}`;
		}
	} catch (failure) {
		settingsError = String(failure?.message ?? failure);
	}
	check("settings panel renders and reveals the transcript tab for the open session", settingsError === "", settingsError);

	// 渲染级：设置面板里那个「选择对话」下拉框，改动后必须经 300ms 防抖 POST 到
	// /interview/config。假 setTimeout 只收下回调，这里手工冲刷。
	let pickerError = "";
	try {
		const node = innerNode(main.component({ t: (k) => k, sessionId: "session-abc" }));
		const selects = [];
		const collect = (current) => {
			if (current === null || current === undefined || typeof current !== "object") return;
			if (current.type === "select") selects.push(current);
			const children = Array.isArray(current.props?.children) ? current.props.children : [current.props?.children];
			for (const child of children) collect(child);
		};
		collect(node);
		const picker = selects.find((item) => {
			const options = Array.isArray(item.props?.children) ? item.props.children : [item.props?.children];
			return options.some((option) => option?.props?.value === "");
		});
		if (picker === undefined) pickerError = `no conversation select among ${selects.length} select(s)`;
		else if (picker.props.value !== "") pickerError = `value=${String(picker.props.value)}`;
		else {
			picker.props.onChange({ target: { value: "s-2" } });
			for (const timer of timers.splice(0)) timer.fn();
			await sleep(0);
			const posted = fetchCalls.filter((call) => call.url.includes("/interview/config"));
			if (posted.length === 0) pickerError = "changing the picker did not POST /interview/config";
			else if (!String(posted.at(-1).init?.body ?? "").includes('"targetSessionId":"s-2"')) {
				pickerError = `body=${String(posted.at(-1).init?.body ?? "")}`;
			}
		}
	} catch (failure) {
		pickerError = String(failure?.message ?? failure);
	}
	check("settings panel offers a conversation picker that pins the delivery target", pickerError === "", pickerError);

	// 渲染级：识别语言下拉框改成 English 后同样经 300ms 防抖 POST 下发。
	let languageError = "";
	try {
		const node = innerNode(main.component({ t: (k) => k, sessionId: "session-abc" }));
		const selects = [];
		const collectAll = (current) => {
			if (current === null || current === undefined || typeof current !== "object") return;
			if (current.type === "select") selects.push(current);
			const children = Array.isArray(current.props?.children) ? current.props.children : [current.props?.children];
			for (const child of children) collectAll(child);
		};
		collectAll(node);
		const picker = selects.find((item) => {
			const options = Array.isArray(item.props?.children) ? item.props.children : [item.props?.children];
			return options.some((option) => option?.props?.value === "en") && options.some((option) => option?.props?.value === "zh");
		});
		if (picker === undefined) languageError = `no language select among ${selects.length} select(s)`;
		else if (picker.props.value !== "auto") languageError = `value=${String(picker.props.value)}`;
		else {
			picker.props.onChange({ target: { value: "en" } });
			for (const timer of timers.splice(0)) timer.fn();
			await sleep(0);
			const posted = fetchCalls.filter((call) => call.url.includes("/interview/config"));
			if (posted.length === 0) languageError = "changing the language did not POST /interview/config";
			else if (!String(posted.at(-1).init?.body ?? "").includes('"language":"en"')) {
				languageError = `body=${String(posted.at(-1).init?.body ?? "")}`;
			}
		}
	} catch (failure) {
		languageError = String(failure?.message ?? failure);
	}
	check("settings panel offers a recognition language picker (auto / 中文 / English)", languageError === "", languageError);

	// 渲染级：知识库下拉框（选资料）/ 路径输入框 / 添加按钮都存在，改选路径后同样
	// 经 300ms 防抖 POST /interview/config，把选中资料写回宿主。
	let knowledgeError = "";
	try {
		const node = innerNode(main.component({ t: (k) => k, sessionId: "session-abc" }));
		const selects = [];
		const inputs = [];
		const buttons = [];
		const walk = (current) => {
			if (current === null || current === undefined || typeof current !== "object") return;
			if (current.type === "select") selects.push(current);
			if (current.type === "input") inputs.push(current);
			if (current.type === "button") buttons.push(current);
			const children = Array.isArray(current.props?.children) ? current.props.children : [current.props?.children];
			for (const child of children) walk(child);
		};
		walk(node);
		const optionsOf = (item) => (Array.isArray(item.props?.children) ? item.props.children : [item.props?.children]);
		const picker = selects.find((item) => optionsOf(item).some((option) => option?.props?.children === "No knowledge base"));
		const pathInput = inputs.find((item) => item.props?.placeholder === "Paste a folder or file path");
		const addButton = buttons.find((item) => item.props?.children === "Add");
		const removeButton = buttons.find((item) => item.props?.children === "Remove");
		if (picker === undefined) knowledgeError = `no knowledge select among ${selects.length} select(s)`;
		else if (pathInput === undefined) knowledgeError = `no knowledge path input among ${inputs.length} input(s)`;
		else if (addButton === undefined) knowledgeError = `no knowledge add button among ${buttons.length} button(s)`;
		else if (removeButton === undefined) knowledgeError = "no knowledge remove button";
		else if (picker.props.value !== "") knowledgeError = `initial value=${String(picker.props.value)}`;
		else {
			picker.props.onChange({ target: { value: "D:\\kb" } });
			for (const timer of timers.splice(0)) timer.fn();
			await sleep(0);
			const posted = fetchCalls.filter((call) => call.url.includes("/interview/config"));
			if (posted.length === 0) knowledgeError = "choosing a knowledge base did not POST /interview/config";
			else if (!String(posted.at(-1).init?.body ?? "").includes('"knowledgeBase"')) {
				knowledgeError = `body=${String(posted.at(-1).init?.body ?? "")}`;
			}
		}
	} catch (failure) {
		knowledgeError = String(failure?.message ?? failure);
	}
	check("settings panel offers a knowledge base picker that pins the inlined material", knowledgeError === "", knowledgeError);

	// 渲染级：提问灵敏度下拉框（strict / standard / high），改档同样经防抖写回宿主。
	let sensitivityError = "";
	try {
		const node = innerNode(main.component({ t: (k) => k, sessionId: "session-abc" }));
		const selects = [];
		const walk = (current) => {
			if (current === null || current === undefined || typeof current !== "object") return;
			if (current.type === "select") selects.push(current);
			const children = Array.isArray(current.props?.children) ? current.props.children : [current.props?.children];
			for (const child of children) walk(child);
		};
		walk(node);
		const optionsOf = (item) => (Array.isArray(item.props?.children) ? item.props.children : [item.props?.children]);
		const picker = selects.find((item) => optionsOf(item).some((option) => option?.props?.children === "High (topic words + follow-up catch, may over-report)"));
		const values = picker === undefined ? [] : optionsOf(picker).map((option) => option?.props?.value);
		if (picker === undefined) sensitivityError = `no sensitivity select among ${selects.length} select(s)`;
		else if (values.join(",") !== "strict,standard,high") sensitivityError = `options=${values.join(",")}`;
		else if (picker.props.value !== "standard") sensitivityError = `initial value=${String(picker.props.value)}`;
		else {
			picker.props.onChange({ target: { value: "high" } });
			for (const timer of timers.splice(0)) timer.fn();
			await sleep(0);
			const posted = fetchCalls.filter((call) => call.url.includes("/interview/config"));
			if (posted.length === 0) sensitivityError = "changing sensitivity did not POST /interview/config";
			else if (!String(posted.at(-1).init?.body ?? "").includes('"questionSensitivity":"high"')) {
				sensitivityError = `body=${String(posted.at(-1).init?.body ?? "")}`;
			}
		}
	} catch (failure) {
		sensitivityError = String(failure?.message ?? failure);
	}
	check("settings panel offers a question sensitivity picker (strict / standard / high)", sensitivityError === "", sensitivityError);

	// 渲染级：「立即回答」按钮在面板里，点一下就 POST /interview/answer-now
	// （宿主会立刻结束当前采集段并投递，不等静音判定）。
	let answerNowError = "";
	try {
		const node = innerNode(main.component({ t: (k) => k, sessionId: "session-abc" }));
		const buttons = [];
		const walk = (current) => {
			if (current === null || current === undefined || typeof current !== "object") return;
			if (current.type === "button") buttons.push(current);
			const children = Array.isArray(current.props?.children) ? current.props.children : [current.props?.children];
			for (const child of children) walk(child);
		};
		walk(node);
		const button = buttons.find((item) => item.props?.children === "Answer now");
		if (button === undefined) answerNowError = `no answer-now button among ${buttons.length} button(s)`;
		else if (button.props?.disabled === true) answerNowError = "answer-now button is disabled while idle";
		else {
			button.props.onClick();
			await sleep(0);
			if (!fetchCalls.some((call) => call.url.includes("/interview/answer-now"))) {
				answerNowError = "clicking answer-now did not POST /interview/answer-now";
			}
		}
	} catch (failure) {
		answerNowError = String(failure?.message ?? failure);
	}
	check("panel offers an answer-now button that flushes the live segment", answerNowError === "", answerNowError);

	// 渲染级：「长回答」按钮挨着补答/立即回答，点了带片段原文 POST /interview/answer-long
	// （宿主会要求同一个问题按 5 分钟口读的细节长版本重答一遍）。
	let answerLongError = "";
	try {
		const node = innerNode(main.component({ t: (k) => k, sessionId: "session-abc" }));
		const buttons = [];
		const walk = (current) => {
			if (current === null || current === undefined || typeof current !== "object") return;
			if (current.type === "button") buttons.push(current);
			const children = Array.isArray(current.props?.children) ? current.props.children : [current.props?.children];
			for (const child of children) walk(child);
		};
		walk(node);
		const button = buttons.find((item) => item.props?.children === "Long answer");
		if (button === undefined) answerLongError = `no long-answer button among ${buttons.length} button(s)`;
		else {
			button.props.onClick();
			await sleep(0);
			const call = fetchCalls.find((item) => item.url.includes("/interview/answer-long"));
			if (call === undefined) answerLongError = "clicking long-answer did not POST /interview/answer-long";
			else if (call.init?.body !== undefined && !String(call.init.body).includes("sessionId")) {
				answerLongError = `long-answer body has no sessionId: ${String(call.init.body)}`;
			}
		}
	} catch (failure) {
		answerLongError = String(failure?.message ?? failure);
	}
	check("panel offers a long-answer button next to the answer buttons", answerLongError === "", answerLongError);

	// A profile without DSH-better-sidebar must still work: no tab type, and the
	// left panel falls back to the full surface so nothing becomes unreachable.
	const fallback = makeCtx(declaredSlots, { betterSidebar: false });
	let fallbackError = "";
	try {
		moduleExports.apply(fallback);
	} catch (failure) {
		fallbackError = String(failure?.message ?? failure);
	}
	check("apply() succeeds without betterSidebar", fallbackError === "", fallbackError);
	check("no tab type registered without the service", fallback.tabs.length === 0, `got ${fallback.tabs.length}`);
	check(
		"the two DSH slots are still registered without the service",
		fallback.registrations.length === 2,
		`got ${fallback.registrations.length}`,
	);
	const fallbackPanel = fallback.registrations.find((r) => r.options?.name === "main");
	let fallbackRenderError = "";
	try {
		const node = innerNode(fallbackPanel.component({ t: (k) => k }));
		fallbackRenderError = node?.props?.["data-dsh-variant"] === "full" ? "" : `variant=${String(node?.props?.["data-dsh-variant"])}`;
	} catch (failure) {
		fallbackRenderError = String(failure?.message ?? failure);
	}
	check("panel falls back to the full variant without the service", fallbackRenderError === "", fallbackRenderError);

	// The owning bundle itself reaches the service through `ctx.get(name)`; a
	// host that exposes only that accessor must still get the tab type.
	const viaGet = makeCtx(declaredSlots, { betterSidebarChannel: "get" });
	let viaGetError = "";
	try {
		moduleExports.apply(viaGet);
	} catch (failure) {
		viaGetError = String(failure?.message ?? failure);
	}
	check("apply() succeeds with ctx.get-only access", viaGetError === "", viaGetError);
	check("tab type registered through ctx.get", viaGet.tabs.length === 1, `got ${viaGet.tabs.length}`);

	// …and the documented property form remains a valid second channel.
	const viaProperty = makeCtx(declaredSlots, { betterSidebarChannel: "property" });
	let viaPropertyError = "";
	try {
		moduleExports.apply(viaProperty);
	} catch (failure) {
		viaPropertyError = String(failure?.message ?? failure);
	}
	check("apply() succeeds with property-only access", viaPropertyError === "", viaPropertyError);
	check("tab type registered through ctx.betterSidebar", viaProperty.tabs.length === 1, `got ${viaProperty.tabs.length}`);
}

// ------------------------------------------------------------ system audio
{
	console.log("# dsh-system-audio/lib/client.js");
	const source = await readFile(SYSTEM_AUDIO_CLIENT, "utf8");
	check(
		"no slots.register({ name: 'conversation.input.left' })",
		!/slots\.register\s*\(\s*\{[^}]*name:\s*["']conversation\.input\.left["']/s.test(source),
	);
	check("no slots.inject('conversation.input.left', ...)", !/slots\.inject\(\s*["']conversation\.input\.left["']/.test(source));
	check("keep-in-place comment documents the removal", /conversation\.input\.left/.test(source));

	const bundle = await loadBundle(SYSTEM_AUDIO_CLIENT);
	const moduleExports = bundle.loaded[0].factory((id) => {
		if (id === "react") return makeReact();
		throw new Error(`unexpected require(${id})`);
	});
	const ctx = makeCtx(declaredSlots);
	moduleExports.apply(ctx);
	check(
		"running apply() performs zero slot registrations",
		ctx.registrations.length === 0,
		JSON.stringify(ctx.registrations.map((r) => r.options?.name)),
	);
	check(
		"still exports apply/inject",
		typeof moduleExports.apply === "function" && JSON.stringify(moduleExports.inject) === JSON.stringify(["slots", "locale"]),
		JSON.stringify(moduleExports.inject),
	);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
