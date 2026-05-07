#!/usr/bin/env node
/**
 * gateway.ts — supervisor for the mybot pi process.
 *
 * Owns the pi lifecycle:
 *   - Spawns pi in --mode rpc.
 *   - Pings it via {"type":"get_state"} every 30s; SIGTERM after 60s no-reply,
 *     SIGKILL 10s later, restart with exponential backoff (cap 5 min).
 *   - Watches runtime/control/restart for an explicit /restart from Telegram.
 *
 * Runs scheduled tasks from runtime/cron.json by spawning a *separate*
 * `pi -p "<prompt>" --no-session` instance per fire. Cron pi instances run
 * with PI_TELEGRAM_CONFIG pointed at an empty config so they don't try to
 * long-poll Telegram (only one poller can exist per bot).
 *
 * Cron output goes to:
 *   - Telegram chat (allowedUserId from runtime/agent/telegram.json) via direct
 *     sendMessage API call (send-only, no polling conflict).
 *   - runtime/log/cron-<id>-<ts>.log (full stdout + stderr).
 *
 * Heartbeat: writes runtime/gateway.health every 5s with state, pids, last
 * health-ok, restart count, next cron fire, last cron run.
 *
 * Event log: runtime/log/gateway.log, JSON lines.
 *
 * Usage:
 *   node scripts/gateway.ts            # foreground, supervises forever
 *   GATEWAY_TEST=1 node scripts/gateway.ts   # run cron-parser self-tests, exit
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// ============================================================================
// Paths + bot identity
// ============================================================================

const REPO_ROOT = (() => {
	// scripts/gateway.ts -> repo root is one level up.
	const here = new URL(".", import.meta.url).pathname;
	return dirname(here.replace(/\/$/, ""));
})();
const RUNTIME_DIR = join(REPO_ROOT, "runtime");
const AGENT_DIR = join(RUNTIME_DIR, "agent");
const CONTROL_DIR = join(RUNTIME_DIR, "control");
const LOG_DIR = join(RUNTIME_DIR, "log");
const HEALTH_PATH = join(RUNTIME_DIR, "gateway.health");
const CRON_PATH = join(RUNTIME_DIR, "cron.json");
const TELEGRAM_CONFIG_PATH = join(AGENT_DIR, "telegram.json");
const TELEGRAM_CRON_CONFIG_PATH = join(AGENT_DIR, "telegram-cron.json");
const RESTART_SENTINEL = join(CONTROL_DIR, "restart");
const GATEWAY_LOG = join(LOG_DIR, "gateway.log");

async function readBotName(): Promise<string> {
	try {
		const name = (await readFile(join(AGENT_DIR, ".bot-name"), "utf8")).trim();
		return name || "pi";
	} catch {
		return "pi";
	}
}

async function readTelegramConfig(): Promise<{ botToken?: string; allowedUserId?: number }> {
	try {
		return JSON.parse(await readFile(TELEGRAM_CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

// ============================================================================
// Cron expression parser (5-field standard cron, no extensions).
// ============================================================================

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	domStar: boolean;
	dowStar: boolean;
}

function parseField(expr: string, min: number, max: number): Set<number> {
	const out = new Set<number>();
	for (const part of expr.split(",")) {
		const slash = part.indexOf("/");
		const stepStr = slash === -1 ? "1" : part.slice(slash + 1);
		const rangeStr = slash === -1 ? part : part.slice(0, slash);
		const step = Number.parseInt(stepStr, 10);
		if (!Number.isFinite(step) || step < 1) {
			throw new Error(`bad step in cron field: ${part}`);
		}
		let lo: number;
		let hi: number;
		if (rangeStr === "*") {
			lo = min;
			hi = max;
		} else if (rangeStr.includes("-")) {
			const [a, b] = rangeStr.split("-").map((s) => Number.parseInt(s, 10));
			if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`bad range in cron field: ${part}`);
			lo = a;
			hi = b;
		} else {
			const v = Number.parseInt(rangeStr, 10);
			if (!Number.isFinite(v)) throw new Error(`bad value in cron field: ${part}`);
			// `5/10` (no range, with step) means "from 5 to max, step 10".
			lo = v;
			hi = slash === -1 ? v : max;
		}
		if (lo < min || hi > max || lo > hi) {
			throw new Error(`out-of-range cron field: ${part} (allowed ${min}-${max})`);
		}
		for (let i = lo; i <= hi; i += step) out.add(i);
	}
	if (out.size === 0) throw new Error(`empty cron field: ${expr}`);
	return out;
}

function parseCron(expr: string): CronFields {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`cron must have 5 fields, got ${parts.length}: ${expr}`);
	return {
		minute: parseField(parts[0], 0, 59),
		hour: parseField(parts[1], 0, 23),
		dom: parseField(parts[2], 1, 31),
		month: parseField(parts[3], 1, 12),
		dow: parseField(parts[4], 0, 6), // Sun=0, Sat=6
		domStar: parts[2] === "*",
		dowStar: parts[4] === "*",
	};
}

/**
 * Returns the next Date matching `expr` strictly after `after`. Operates in
 * the local timezone (matches user expectation for scheduling, e.g. "8am").
 * Caps at 366 days of search (anything that doesn't fire in a year is bogus).
 */
function nextFire(expr: string, after: Date): Date {
	const f = parseCron(expr);
	const start = new Date(after.getTime());
	// Round up to next minute boundary.
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);
	const limit = new Date(start.getTime() + 366 * 24 * 60 * 60 * 1000);
	const cur = new Date(start.getTime());
	while (cur <= limit) {
		if (!f.month.has(cur.getMonth() + 1)) {
			// Jump to first day of next month, midnight.
			cur.setDate(1);
			cur.setHours(0, 0, 0, 0);
			cur.setMonth(cur.getMonth() + 1);
			continue;
		}
		const dayMatches =
			f.domStar && f.dowStar
				? true
				: f.domStar
					? f.dow.has(cur.getDay())
					: f.dowStar
						? f.dom.has(cur.getDate())
						: f.dom.has(cur.getDate()) || f.dow.has(cur.getDay());
		if (!dayMatches) {
			cur.setHours(0, 0, 0, 0);
			cur.setDate(cur.getDate() + 1);
			continue;
		}
		if (!f.hour.has(cur.getHours())) {
			cur.setMinutes(0, 0, 0);
			cur.setHours(cur.getHours() + 1);
			continue;
		}
		if (!f.minute.has(cur.getMinutes())) {
			cur.setSeconds(0, 0);
			cur.setMinutes(cur.getMinutes() + 1);
			continue;
		}
		return cur;
	}
	throw new Error(`cron expression "${expr}" did not fire within 366 days`);
}

// ============================================================================
// Inline self-tests for the cron parser. Run with GATEWAY_TEST=1.
// ============================================================================

function runSelfTests(): void {
	const cases: Array<[string, string, string]> = [
		// [expr, "from <ISO>", "expect <ISO>"] — local time.
		["0 8 * * *", "2026-05-07T07:30:00", "2026-05-07T08:00:00"],
		["0 8 * * *", "2026-05-07T08:00:00", "2026-05-08T08:00:00"], // strictly after
		["*/5 * * * *", "2026-05-07T08:00:00", "2026-05-07T08:05:00"],
		["*/5 * * * *", "2026-05-07T08:03:00", "2026-05-07T08:05:00"],
		["0 0 * * 0", "2026-05-07T00:00:00", "2026-05-10T00:00:00"], // next Sunday
		["30 9 1 * *", "2026-05-07T00:00:00", "2026-06-01T09:30:00"], // next 1st of month
		["0 12 * * 1-5", "2026-05-08T15:00:00", "2026-05-11T12:00:00"], // Sat 15:00 -> Mon 12:00
		["15,45 * * * *", "2026-05-07T08:20:00", "2026-05-07T08:45:00"],
	];
	let ok = 0;
	let fail = 0;
	for (const [expr, fromIso, expectIso] of cases) {
		const from = new Date(fromIso);
		const expect = new Date(expectIso);
		const got = nextFire(expr, from);
		if (got.getTime() === expect.getTime()) {
			ok++;
		} else {
			fail++;
			console.error(`FAIL ${expr} from ${fromIso}: expected ${expectIso}, got ${got.toISOString()}`);
		}
	}
	if (fail === 0) {
		console.log(`OK (${ok}/${cases.length})`);
		process.exit(0);
	} else {
		console.error(`FAIL (${fail}/${cases.length})`);
		process.exit(1);
	}
}

if (process.env.GATEWAY_TEST) {
	runSelfTests();
}

// ============================================================================
// Cron storage
// ============================================================================

interface CronTask {
	id: string;
	schedule: string;
	prompt: string;
	enabled: boolean;
	lastRun?: string | null;
	lastStatus?: "ok" | "error" | null;
	lastError?: string | null;
}

interface CronFile {
	tasks: CronTask[];
}

async function readCronFile(): Promise<CronFile> {
	try {
		const raw = await readFile(CRON_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.tasks)) return { tasks: [] };
		return parsed as CronFile;
	} catch {
		return { tasks: [] };
	}
}

/**
 * Writes only the gateway-owned fields (lastRun/lastStatus/lastError) for a
 * single task, re-reading the file first to avoid clobbering an in-flight
 * /cron edit. Atomic via rename.
 */
async function patchCronTaskState(
	taskId: string,
	patch: { lastRun?: string; lastStatus?: "ok" | "error"; lastError?: string | null },
): Promise<void> {
	const file = await readCronFile();
	const task = file.tasks.find((t) => t.id === taskId);
	if (!task) return;
	if (patch.lastRun !== undefined) task.lastRun = patch.lastRun;
	if (patch.lastStatus !== undefined) task.lastStatus = patch.lastStatus;
	if (patch.lastError !== undefined) task.lastError = patch.lastError;
	const tmp = `${CRON_PATH}.tmp`;
	await writeFile(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	await rename(tmp, CRON_PATH);
}

// ============================================================================
// Logging + heartbeat
// ============================================================================

type GatewayEvent =
	| { type: "gateway_start" }
	| { type: "pi_spawn"; pid: number }
	| { type: "pi_exit"; pid: number; code: number | null; signal: string | null }
	| { type: "health_ok"; pid: number }
	| { type: "health_timeout"; pid: number }
	| { type: "kill_term"; pid: number }
	| { type: "kill_force"; pid: number }
	| { type: "restart_requested" }
	| { type: "backoff"; ms: number; attempt: number }
	| { type: "cron_fire"; id: string; trigger: "schedule" | "manual" }
	| { type: "cron_result"; id: string; status: "ok" | "error"; durationMs: number; exitCode: number | null }
	| { type: "cron_telegram_send"; id: string; ok: boolean; error?: string }
	| { type: "cron_skip_busy"; id: string; queued: number }
	| { type: "shutdown"; signal: string };

async function logEvent(ev: GatewayEvent): Promise<void> {
	const line = `${JSON.stringify({ at: new Date().toISOString(), ...ev })}\n`;
	try {
		await appendFile(GATEWAY_LOG, line, "utf8");
	} catch {
		// Best-effort. Don't crash on log write failure.
	}
}

interface HeartbeatState {
	gatewayPid: number;
	gatewayStartedAt: string;
	piPid: number | null;
	piStartedAt: string | null;
	piState: "alive" | "starting" | "killed" | "exited";
	lastHealthOk: string | null;
	restartCount: number;
	cron: {
		nextFire: string | null;
		nextFireTaskId: string | null;
		lastRun: { id: string; at: string; status: "ok" | "error" } | null;
		runningTaskIds: string[];
	};
}

const heartbeat: HeartbeatState = {
	gatewayPid: process.pid,
	gatewayStartedAt: new Date().toISOString(),
	piPid: null,
	piStartedAt: null,
	piState: "starting",
	lastHealthOk: null,
	restartCount: 0,
	cron: { nextFire: null, nextFireTaskId: null, lastRun: null, runningTaskIds: [] },
};

async function writeHeartbeat(): Promise<void> {
	try {
		await writeFile(HEALTH_PATH, `${JSON.stringify(heartbeat, null, "\t")}\n`, "utf8");
	} catch {
		// Best-effort.
	}
}

// ============================================================================
// Pi process supervisor
// ============================================================================

interface PiSupervisor {
	getChild(): ChildProcess | undefined;
	requestRestart(): void;
	stop(): Promise<void>;
}

interface PendingPing {
	id: string;
	deadline: number;
	resolve: () => void;
	reject: (err: Error) => void;
}

function buildPiEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		PI_TELEGRAM_CONFIG: TELEGRAM_CONFIG_PATH,
		PI_MEMORY_DIR: join(AGENT_DIR, "memory"),
		QMD_CONFIG_DIR: join(RUNTIME_DIR, "qmd-config"),
		XDG_CACHE_HOME: join(RUNTIME_DIR, "cache"),
		PATH: `${join(RUNTIME_DIR, "bun", "bin")}:${process.env.PATH ?? ""}`,
	};
}

function buildCronPiEnv(): NodeJS.ProcessEnv {
	// Same as live pi, except point telegram config at the empty file so the
	// cron pi instance does NOT start polling (one poller per bot).
	return {
		...buildPiEnv(),
		PI_TELEGRAM_CONFIG: TELEGRAM_CRON_CONFIG_PATH,
	};
}

async function ensureCronEmptyTelegramConfig(): Promise<void> {
	if (!existsSync(TELEGRAM_CRON_CONFIG_PATH)) {
		await writeFile(TELEGRAM_CRON_CONFIG_PATH, "{}\n", "utf8");
	}
}

async function startPiSupervisor(binPath: string): Promise<PiSupervisor> {
	const HEALTH_INTERVAL_MS = 30_000;
	const HEALTH_TIMEOUT_MS = 60_000;
	const KILL_GRACE_MS = 10_000;
	const STABLE_RESET_MS = 60_000;
	const BACKOFF_CAP_MS = 300_000;

	let child: ChildProcess | undefined;
	let pingCounter = 0;
	let pendingPings: PendingPing[] = [];
	let stdoutBuf = "";
	let healthTimer: NodeJS.Timeout | undefined;
	let restartRequested = false;
	let stopping = false;
	let attempt = 0;
	let lastSpawnAt = 0;

	async function spawnPi(): Promise<void> {
		if (stopping) return;

		// Apply backoff if we just crashed.
		if (attempt > 0) {
			const backoff = Math.min(1000 * 2 ** (attempt - 1), BACKOFF_CAP_MS);
			heartbeat.piState = "starting";
			await writeHeartbeat();
			await logEvent({ type: "backoff", ms: backoff, attempt });
			await delay(backoff);
			if (stopping) return;
		}

		lastSpawnAt = Date.now();
		const proc = spawn(binPath, ["--mode", "rpc"], {
			cwd: REPO_ROOT,
			env: buildPiEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = proc;
		heartbeat.piPid = proc.pid ?? null;
		heartbeat.piStartedAt = new Date().toISOString();
		heartbeat.piState = "alive";
		await writeHeartbeat();
		await logEvent({ type: "pi_spawn", pid: proc.pid ?? -1 });

		stdoutBuf = "";
		pendingPings = [];

		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			stdoutBuf += chunk;
			let nl = stdoutBuf.indexOf("\n");
			while (nl !== -1) {
				const line = stdoutBuf.slice(0, nl);
				stdoutBuf = stdoutBuf.slice(nl + 1);
				// Mirror to gateway stdout so existing tmux/log capture keeps working.
				process.stdout.write(`${line}\n`);
				if (line.length > 0) handleRpcLine(line);
				nl = stdoutBuf.indexOf("\n");
			}
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			process.stderr.write(chunk);
		});

		proc.on("exit", async (code, signal) => {
			const exitedPid = proc.pid ?? -1;
			heartbeat.piState = "exited";
			heartbeat.piPid = null;
			await writeHeartbeat();
			await logEvent({ type: "pi_exit", pid: exitedPid, code, signal });
			for (const p of pendingPings) p.reject(new Error("pi exited"));
			pendingPings = [];
			if (healthTimer) {
				clearInterval(healthTimer);
				healthTimer = undefined;
			}
			if (stopping) return;
			child = undefined;
			// Stable-uptime reset: if pi ran for >60s, treat as a fresh attempt.
			const uptime = Date.now() - lastSpawnAt;
			attempt = uptime > STABLE_RESET_MS ? 1 : attempt + 1;
			heartbeat.restartCount += 1;
			void spawnPi();
		});

		// Kick off health probe loop.
		healthTimer = setInterval(() => {
			void doHealthProbe();
		}, HEALTH_INTERVAL_MS);
	}

	function handleRpcLine(line: string): void {
		// Only inspect well-formed responses to our health pings; pi emits many
		// other event lines we don't care about.
		if (!line.startsWith("{")) return;
		try {
			const parsed = JSON.parse(line) as { id?: string; type?: string; command?: string };
			if (parsed.type !== "response" || !parsed.id) return;
			const idx = pendingPings.findIndex((p) => p.id === parsed.id);
			if (idx === -1) return;
			const ping = pendingPings.splice(idx, 1)[0];
			ping.resolve();
		} catch {
			// Not JSON we care about.
		}
	}

	async function doHealthProbe(): Promise<void> {
		const proc = child;
		if (!proc || !proc.stdin || proc.stdin.destroyed) return;
		const id = `hc-${++pingCounter}`;
		const cmd = `${JSON.stringify({ id, type: "get_state" })}\n`;
		const ping: PendingPing = {
			id,
			deadline: Date.now() + HEALTH_TIMEOUT_MS,
			resolve: () => {},
			reject: () => {},
		};
		const promise = new Promise<void>((resolve, reject) => {
			ping.resolve = resolve;
			ping.reject = reject;
		});
		pendingPings.push(ping);
		try {
			proc.stdin.write(cmd);
		} catch {
			// stdin write failure → kill and let restart loop respawn.
			pendingPings = pendingPings.filter((p) => p !== ping);
			await forceKill();
			return;
		}
		try {
			await Promise.race([
				promise,
				delay(HEALTH_TIMEOUT_MS).then(() => {
					throw new Error("health timeout");
				}),
			]);
			heartbeat.lastHealthOk = new Date().toISOString();
			void writeHeartbeat();
			await logEvent({ type: "health_ok", pid: proc.pid ?? -1 });
		} catch {
			pendingPings = pendingPings.filter((p) => p !== ping);
			await logEvent({ type: "health_timeout", pid: proc.pid ?? -1 });
			await forceKill();
		}
	}

	async function forceKill(): Promise<void> {
		const proc = child;
		if (!proc) return;
		await logEvent({ type: "kill_term", pid: proc.pid ?? -1 });
		try {
			proc.kill("SIGTERM");
		} catch {}
		const start = Date.now();
		while (proc.exitCode === null && proc.signalCode === null && Date.now() - start < KILL_GRACE_MS) {
			await delay(200);
		}
		if (proc.exitCode === null && proc.signalCode === null) {
			await logEvent({ type: "kill_force", pid: proc.pid ?? -1 });
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
	}

	async function requestRestartImpl(): Promise<void> {
		if (restartRequested) return;
		restartRequested = true;
		await logEvent({ type: "restart_requested" });
		await forceKill();
		// `exit` listener handles respawn; clear flag once child gone.
		const startedPid = child?.pid;
		while (child?.pid === startedPid && child !== undefined) {
			await delay(100);
		}
		restartRequested = false;
	}

	async function stop(): Promise<void> {
		stopping = true;
		if (healthTimer) {
			clearInterval(healthTimer);
			healthTimer = undefined;
		}
		await forceKill();
	}

	// First boot: no backoff.
	attempt = 0;
	void spawnPi();

	return {
		getChild: () => child,
		requestRestart: () => {
			void requestRestartImpl();
		},
		stop,
	};
}

// ============================================================================
// Restart sentinel watcher
// ============================================================================

async function watchRestartSentinel(supervisor: PiSupervisor, abort: AbortSignal): Promise<void> {
	let lastSeenMtime = 0;
	while (!abort.aborted) {
		try {
			const st = await stat(RESTART_SENTINEL);
			const mtime = st.mtimeMs;
			if (mtime !== lastSeenMtime) {
				lastSeenMtime = mtime;
				supervisor.requestRestart();
				try {
					await unlink(RESTART_SENTINEL);
				} catch {}
			}
		} catch {
			// Sentinel doesn't exist; that's the steady state.
		}
		await delay(1000);
	}
}

// ============================================================================
// Cron loop
// ============================================================================

interface CronRuntimeState {
	nextFireAt: Map<string, number>; // taskId -> ms epoch
	running: Set<string>;
	lastConfigMtime: number;
	queued: string[]; // taskIds awaiting an idle slot (manual run requests included)
}

async function sendTelegramMessage(text: string): Promise<{ ok: boolean; error?: string }> {
	const cfg = await readTelegramConfig();
	if (!cfg.botToken || !cfg.allowedUserId) {
		return { ok: false, error: "telegram.json missing botToken or allowedUserId" };
	}
	try {
		// Telegram caps text at 4096 chars per message.
		const MAX = 4096;
		const chunks: string[] = [];
		for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
		for (const chunk of chunks) {
			const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: cfg.allowedUserId, text: chunk, disable_web_page_preview: true }),
			});
			if (!res.ok) {
				return { ok: false, error: `telegram ${res.status}: ${await res.text().catch(() => "")}` };
			}
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function runCronTask(
	binPath: string,
	task: CronTask,
	trigger: "schedule" | "manual",
	state: CronRuntimeState,
): Promise<void> {
	state.running.add(task.id);
	heartbeat.cron.runningTaskIds = [...state.running];
	void writeHeartbeat();

	const startMs = Date.now();
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logPath = join(LOG_DIR, `cron-${task.id}-${ts}.log`);
	await logEvent({ type: "cron_fire", id: task.id, trigger });

	const proc = spawn(binPath, ["--print", "--no-session", task.prompt], {
		cwd: REPO_ROOT,
		env: buildCronPiEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const exitCode: number | null = await new Promise((resolve) => {
		proc.on("exit", (code) => resolve(code));
	});

	const durationMs = Date.now() - startMs;
	const status: "ok" | "error" = exitCode === 0 ? "ok" : "error";

	await writeFile(
		logPath,
		`# cron task: ${task.id}\n# trigger: ${trigger}\n# schedule: ${task.schedule}\n# prompt: ${task.prompt}\n# started: ${new Date(startMs).toISOString()}\n# duration: ${durationMs}ms\n# exit: ${exitCode}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
		"utf8",
	);

	await logEvent({ type: "cron_result", id: task.id, status, durationMs, exitCode });

	const replyHeader = `[cron ${task.id}] ${status === "ok" ? "" : "FAILED "}`;
	let replyBody: string;
	if (status === "ok") {
		replyBody = stdout.trim() || "(no output)";
	} else {
		const errLine = stderr.trim().split("\n").pop() ?? "";
		replyBody = `exit=${exitCode}${errLine ? `: ${errLine}` : ""}`;
	}
	const sendResult = await sendTelegramMessage(`${replyHeader}${replyBody}`);
	await logEvent({ type: "cron_telegram_send", id: task.id, ok: sendResult.ok, error: sendResult.error });

	await patchCronTaskState(task.id, {
		lastRun: new Date(startMs).toISOString(),
		lastStatus: status,
		lastError: status === "error" ? stderr.trim().split("\n").pop() ?? null : null,
	});
	heartbeat.cron.lastRun = { id: task.id, at: new Date(startMs).toISOString(), status };

	state.running.delete(task.id);
	heartbeat.cron.runningTaskIds = [...state.running];
	void writeHeartbeat();
}

async function cronLoop(binPath: string, abort: AbortSignal): Promise<void> {
	const TICK_MS = 30_000;
	const MAX_QUEUE = 3;
	const state: CronRuntimeState = {
		nextFireAt: new Map(),
		running: new Set(),
		lastConfigMtime: 0,
		queued: [],
	};

	async function refreshSchedule(file: CronFile, now: number): Promise<void> {
		const liveIds = new Set(file.tasks.filter((t) => t.enabled).map((t) => t.id));
		for (const id of [...state.nextFireAt.keys()]) {
			if (!liveIds.has(id)) state.nextFireAt.delete(id);
		}
		for (const task of file.tasks) {
			if (!task.enabled) continue;
			if (state.nextFireAt.has(task.id)) continue;
			try {
				const next = nextFire(task.schedule, new Date(now));
				state.nextFireAt.set(task.id, next.getTime());
			} catch (err) {
				console.error(`[gateway] bad cron expr for ${task.id}: ${err instanceof Error ? err.message : err}`);
			}
		}
	}

	function updateHeartbeatNextFire(): void {
		let bestId: string | null = null;
		let bestAt: number | null = null;
		for (const [id, at] of state.nextFireAt) {
			if (bestAt === null || at < bestAt) {
				bestAt = at;
				bestId = id;
			}
		}
		heartbeat.cron.nextFire = bestAt ? new Date(bestAt).toISOString() : null;
		heartbeat.cron.nextFireTaskId = bestId;
	}

	async function checkManualRunSentinels(file: CronFile): Promise<void> {
		// runtime/control/run-<taskId> => fire that task once.
		for (const task of file.tasks) {
			const sentinel = join(CONTROL_DIR, `run-${task.id}`);
			if (existsSync(sentinel)) {
				try {
					await unlink(sentinel);
				} catch {}
				if (state.running.has(task.id)) {
					if (state.queued.length >= MAX_QUEUE) {
						await logEvent({ type: "cron_skip_busy", id: task.id, queued: state.queued.length });
					} else {
						state.queued.push(task.id);
					}
				} else {
					void runCronTask(binPath, task, "manual", state);
				}
			}
		}
	}

	while (!abort.aborted) {
		try {
			let mtime = 0;
			try {
				mtime = (await stat(CRON_PATH)).mtimeMs;
			} catch {}
			let file: CronFile;
			if (mtime !== state.lastConfigMtime) {
				state.lastConfigMtime = mtime;
				file = await readCronFile();
				await refreshSchedule(file, Date.now());
			} else {
				file = await readCronFile();
			}

			await checkManualRunSentinels(file);

			const now = Date.now();
			for (const task of file.tasks) {
				if (!task.enabled) continue;
				const at = state.nextFireAt.get(task.id);
				if (at === undefined || now < at) continue;
				if (state.running.has(task.id)) {
					await logEvent({ type: "cron_skip_busy", id: task.id, queued: state.queued.length });
				} else {
					void runCronTask(binPath, task, "schedule", state);
				}
				// Advance schedule strictly past `now` so we don't burst-fire after downtime.
				const nxt = nextFire(task.schedule, new Date(now));
				state.nextFireAt.set(task.id, nxt.getTime());
			}

			// Drain queue for any task that is no longer running.
			while (state.queued.length > 0) {
				const id = state.queued[0];
				if (state.running.has(id)) break;
				state.queued.shift();
				const task = file.tasks.find((t) => t.id === id);
				if (task) void runCronTask(binPath, task, "manual", state);
			}

			updateHeartbeatNextFire();
		} catch (err) {
			console.error(`[gateway] cron loop error: ${err instanceof Error ? err.message : err}`);
		}
		await delay(TICK_MS);
	}
}

// ============================================================================
// Heartbeat loop + main
// ============================================================================

async function heartbeatLoop(abort: AbortSignal): Promise<void> {
	while (!abort.aborted) {
		await writeHeartbeat();
		await delay(5000);
	}
}

async function main(): Promise<void> {
	await mkdir(CONTROL_DIR, { recursive: true });
	await mkdir(LOG_DIR, { recursive: true });
	await ensureCronEmptyTelegramConfig();
	if (!existsSync(CRON_PATH)) {
		await writeFile(CRON_PATH, `${JSON.stringify({ tasks: [] }, null, "\t")}\n`, "utf8");
	}
	// Drop any stale restart sentinel from a previous run so we don't insta-restart on boot.
	try {
		await unlink(RESTART_SENTINEL);
	} catch {}

	const botName = await readBotName();
	const binPath = join(RUNTIME_DIR, "bin", botName);
	if (!existsSync(binPath)) {
		console.error(`[gateway] missing pi binary at ${binPath} — run ./setup.sh first`);
		process.exit(1);
	}

	await logEvent({ type: "gateway_start" });

	const supervisor = await startPiSupervisor(binPath);
	const abortController = new AbortController();

	const handleSignal = (signal: NodeJS.Signals) => {
		void (async () => {
			await logEvent({ type: "shutdown", signal });
			abortController.abort();
			await supervisor.stop();
			process.exit(0);
		})();
	};
	process.on("SIGTERM", () => handleSignal("SIGTERM"));
	process.on("SIGINT", () => handleSignal("SIGINT"));
	process.on("SIGHUP", () => handleSignal("SIGHUP"));

	void watchRestartSentinel(supervisor, abortController.signal);
	void cronLoop(binPath, abortController.signal);
	void heartbeatLoop(abortController.signal);

	// Idle forever; everything else runs via timers/listeners.
	await new Promise(() => {});
}

void main().catch((err) => {
	console.error(`[gateway] fatal: ${err instanceof Error ? err.stack : err}`);
	process.exit(1);
});
