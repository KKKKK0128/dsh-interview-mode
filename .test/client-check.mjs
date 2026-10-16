// Offline self-check for dsh-interview-mode's browser half.
//
// Loads lib/client.js through a fake `window.__ModuleLoader__` plus a minimal
// React stand-in, runs the returned `apply(ctx)` against a recording slot host,
// and asserts the placement contract from PLAN.md v1.1:
//
//   1. exactly two registrations: `sidebar.panellist` (id 'interview') and
//      `main` (key 'interview');
//   2. NOTHING registered into `conversation.input.*`;
//   3. dsh-system-audio's client.js no longer registers into
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
function makeCtx(declaredSlots) {
	const declared = new Set(declaredSlots);
	const ctx = {
		registrations: [],
		effects: [],
		declaredChecks: [],
		localeRegistrations: [],
		locale: {
			register(namespace, table) {
				ctx.localeRegistrations.push({ namespace, table });
				return () => {};
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
async function loadClient(file, windowObject, dom) {
	const source = await readFile(file, "utf8");
	const previousWindow = globalThis.window;
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
			async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }),
			() => 0,
			() => 0,
			() => {},
			() => {},
		);
	} finally {
		globalThis.window = previousWindow;
	}
}

const declaredSlots = ["main", "sidebar.panellist", "conversation.input.left", "conversation.input.right", "conversation.input.toolbar"];

async function loadBundle(file, optionalRequires = []) {
	const loaded = [];
	const dom = makeFakeDom();
	const windowObject = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } };
	await loadClient(file, windowObject, dom);
	return { loaded, dom, windowObject, file, optionalRequires };
}

// ---------------------------------------------------------------- interview
{
	console.log("# dsh-interview-mode/lib/client.js");
	const source = await readFile(INTERVIEW_CLIENT, "utf8");
	const bundle = await loadBundle(INTERVIEW_CLIENT);
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
