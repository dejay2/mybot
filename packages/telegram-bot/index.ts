import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: {
		message_id: number;
		chat: TelegramChat;
		text?: string;
	};
	data?: string;
}

interface TelegramCallbackAnswer {
	ok: boolean;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

// PI_TELEGRAM_CONFIG overrides the config file path so dev/test bots can run
// alongside a prod bot on the same box without clobbering the default config.
const CONFIG_PATH = process.env.PI_TELEGRAM_CONFIG ?? join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const UI_PROMPT_TIMEOUT_MS = 5 * 60_000;

// Thinking-level UI. Levels are clamped per-model by pi.setThinkingLevel; we
// always show all 6 buttons so the user can ask for "high" on a model that
// only supports "medium" — pi will silently land them on the closest available.
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
};

// Inline-prefix display for assistant thinking blocks. When pi's thinking
// level is non-off, assistant messages contain `{ type: "thinking", thinking }`
// blocks alongside the final text. We render them as a one-shot prefix so the
// user can see the model's reasoning without wading through it. Cap and
// middle-elide to stay well below Telegram's 4096-char message limit.
const THINKING_INLINE_HEADER = "🧠 thinking";
const THINKING_INLINE_SEPARATOR = "─────";
const THINKING_INLINE_BUDGET = 1500;

function truncateThinking(text: string): string {
	if (text.length <= THINKING_INLINE_BUDGET) return text;
	const half = Math.floor((THINKING_INLINE_BUDGET - 20) / 2);
	return `${text.slice(0, half)}\n[…elided…]\n${text.slice(text.length - half)}`;
}

function extractMessageBlocks(message: AgentMessage): { thinking: string; text: string } {
	const value = message as unknown as Record<string, unknown>;
	const content = Array.isArray(value.content) ? value.content : [];
	let thinking = "";
	let text = "";
	for (const raw of content) {
		if (typeof raw !== "object" || raw === null || !("type" in raw)) continue;
		const block = raw as { type: string; text?: string; thinking?: string; redacted?: boolean };
		if (block.type === "thinking" && typeof block.thinking === "string" && !block.redacted) {
			thinking += block.thinking;
		} else if (block.type === "text" && typeof block.text === "string") {
			text += block.text;
		}
	}
	return { thinking: thinking.trim(), text: text.trim() };
}

function formatMessageWithThinking(blocks: { thinking: string; text: string }): string {
	if (!blocks.thinking) return blocks.text;
	const truncated = truncateThinking(blocks.thinking);
	if (!blocks.text) return `${THINKING_INLINE_HEADER}\n${truncated}`;
	return `${THINKING_INLINE_HEADER}\n${truncated}\n\n${THINKING_INLINE_SEPARATOR}\n\n${blocks.text}`;
}

// ============================================================================
// Gateway integration
// ============================================================================
//
// When the bot runs under scripts/gateway.ts (the supervisor), three control
// surfaces are visible to this extension:
//   - runtime/control/restart        — touched to ask the gateway to bounce pi
//   - runtime/control/run-<taskId>   — touched to fire one cron task immediately
//   - runtime/gateway.health         — heartbeat JSON written by the gateway
//   - runtime/cron.json              — schedule + per-task state
//
// Paths are resolved off PI_CODING_AGENT_DIR (set to <runtime>/agent by both
// start.sh and gateway.ts), so the runtime dir is always its parent. If this
// extension is loaded outside the mybot layout (e.g. ~/.pi/agent), the gateway
// commands degrade with a clear "gateway not running" message.

interface GatewayPaths {
	runtimeDir: string;
	controlDir: string;
	healthPath: string;
	cronPath: string;
}

function resolveGatewayPaths(): GatewayPaths {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const runtimeDir = dirname(agentDir);
	return {
		runtimeDir,
		controlDir: join(runtimeDir, "control"),
		healthPath: join(runtimeDir, "gateway.health"),
		cronPath: join(runtimeDir, "cron.json"),
	};
}

interface GatewayHealth {
	gatewayPid?: number;
	gatewayStartedAt?: string;
	piPid?: number | null;
	piStartedAt?: string | null;
	piState?: string;
	lastHealthOk?: string | null;
	restartCount?: number;
	cron?: {
		nextFire?: string | null;
		nextFireTaskId?: string | null;
		lastRun?: { id: string; at: string; status: "ok" | "error" } | null;
		runningTaskIds?: string[];
	};
}

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

async function readGatewayHealth(paths: GatewayPaths): Promise<GatewayHealth | null> {
	try {
		return JSON.parse(await readFile(paths.healthPath, "utf8"));
	} catch {
		return null;
	}
}

async function readCronFileSafe(paths: GatewayPaths): Promise<CronFile> {
	try {
		const parsed = JSON.parse(await readFile(paths.cronPath, "utf8"));
		if (!parsed || !Array.isArray(parsed.tasks)) return { tasks: [] };
		return parsed as CronFile;
	} catch {
		return { tasks: [] };
	}
}

async function writeCronFileAtomic(paths: GatewayPaths, file: CronFile): Promise<void> {
	const tmp = `${paths.cronPath}.tmp`;
	await writeFile(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	await rename(tmp, paths.cronPath);
}

function isValidCronExpr(expr: string): boolean {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const ranges: Array<[number, number]> = [
		[0, 59], [0, 23], [1, 31], [1, 12], [0, 6],
	];
	for (let i = 0; i < 5; i++) {
		const [min, max] = ranges[i];
		for (const part of parts[i].split(",")) {
			const [rangeStr, stepStr] = part.includes("/") ? part.split("/") : [part, "1"];
			if (!/^\d+$/.test(stepStr) || Number.parseInt(stepStr, 10) < 1) return false;
			if (rangeStr === "*") continue;
			if (rangeStr.includes("-")) {
				const [a, b] = rangeStr.split("-");
				if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
				const lo = Number.parseInt(a, 10);
				const hi = Number.parseInt(b, 10);
				if (lo < min || hi > max || lo > hi) return false;
			} else if (/^\d+$/.test(rangeStr)) {
				const v = Number.parseInt(rangeStr, 10);
				if (v < min || v > max) return false;
			} else {
				return false;
			}
		}
	}
	return true;
}

function isValidCronTaskId(id: string): boolean {
	return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

function formatHealth(health: GatewayHealth | null): string {
	if (!health) return "Gateway not running (no runtime/gateway.health found).";
	const lines: string[] = [];
	lines.push(`gateway pid: ${health.gatewayPid ?? "?"} (since ${health.gatewayStartedAt ?? "?"})`);
	lines.push(`pi pid: ${health.piPid ?? "?"} (state: ${health.piState ?? "?"})`);
	lines.push(`last health ok: ${health.lastHealthOk ?? "never"}`);
	lines.push(`restart count: ${health.restartCount ?? 0}`);
	const cron = health.cron;
	if (cron) {
		if (cron.nextFire && cron.nextFireTaskId) {
			lines.push(`next cron: ${cron.nextFireTaskId} @ ${cron.nextFire}`);
		} else {
			lines.push("next cron: (none scheduled)");
		}
		if (cron.lastRun) {
			lines.push(`last cron: ${cron.lastRun.id} @ ${cron.lastRun.at} (${cron.lastRun.status})`);
		}
		if (cron.runningTaskIds && cron.runningTaskIds.length > 0) {
			lines.push(`running: ${cron.runningTaskIds.join(", ")}`);
		}
	}
	return lines.join("\n");
}

function formatCronList(file: CronFile): string {
	if (file.tasks.length === 0) return "No scheduled tasks. Add one with /cron add <id> <expr5> <prompt>";
	const lines: string[] = [];
	for (const task of file.tasks) {
		const tag = task.enabled ? "" : " [disabled]";
		const last = task.lastRun ? ` (last: ${task.lastRun} ${task.lastStatus ?? "?"})` : "";
		lines.push(`${task.id}${tag}: ${task.schedule}${last}`);
		lines.push(`  ${task.prompt}`);
	}
	return lines.join("\n");
}

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let previewState: TelegramPreviewState | undefined;
	let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	// Set by the slash-command dispatcher right before invoking pi.executeCommand,
	// so gateway-aware command handlers (/restart, /health, /cron) can reply
	// directly to the originating Telegram message instead of relying on the
	// generic post-dispatch ack. Cleared in the dispatcher's finally block.
	let pendingTelegramCommandReply:
		| { chatId: number; messageId: number; suppressAck: boolean }
		| undefined;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();
	// chatId -> { models, messageId, page } for pending model picker keyboards
	const pendingModelSelections = new Map<
		number,
		{
			models: Array<{
				ref: string;
				provider: string;
				id: string;
				name?: string;
			}>;
			messageId: number;
			page: number;
		}
	>();
	// chatId -> messageId for pending /thinking picker keyboards
	const pendingThinkingSelections = new Map<number, { messageId: number }>();
	// chatId -> in-flight ctx.ui prompt awaiting an answer from Telegram. At most
	// one prompt per chat. Cleared on answer, cancel, timeout, or session_shutdown.
	type PendingUiPrompt =
		| {
				kind: "confirm";
				chatId: number;
				messageId: number;
				resolve: (v: boolean) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| {
				kind: "select";
				chatId: number;
				messageId: number;
				options: string[];
				resolve: (v: string | undefined) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| {
				kind: "input";
				chatId: number;
				messageId: number;
				resolve: (v: string | undefined) => void;
				timer: ReturnType<typeof setTimeout>;
		  };
	const pendingUiPrompts = new Map<number, PendingUiPrompt>();

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		// ctx may be stale if the session was replaced (e.g. /new triggered via
		// pi.executeCommand) while the polling lifecycle still holds a reference.
		// Touching a stale ctx throws; the status indicator is decorative, so
		// swallow the error rather than tearing pi down.
		try {
			const theme = ctx.ui.theme;
			const label = theme.fg("accent", "telegram");
			if (error) {
				ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
				return;
			}
			if (!config.botToken) {
				ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
				return;
			}
			if (!pollingPromise) {
				ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
				return;
			}
			if (!config.allowedUserId) {
				ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
				return;
			}
			if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
				const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
				ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
				return;
			}
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
		} catch {
			// ctx is stale after a session replacement — ignore.
		}
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	let lastSyncedCommandsHash: string | undefined;
	let activeReverseMap: Map<string, string> = new Map();
	// `/run_<sanitized>` -> original agent name. Populated alongside
	// activeReverseMap by syncTelegramCommands so the dispatcher can recognise
	// agent commands and route them to the flag picker instead of pi.executeCommand.
	let activeAgentCommandMap: Map<string, string> = new Map();

	function sanitizeTelegramCommandName(raw: string): string | undefined {
		const lowered = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
		if (!lowered) return undefined;
		return lowered.slice(0, 32);
	}

	// Agents discovered from pi-subagents' canonical directory layout.
	// Mirrors discoverAgents() in @mariozechner/pi-subagents — duplicated rather
	// than imported because the package isn't a peer dep and resolves to a
	// global npm install we can't see from this workspace.
	interface DiscoveredAgent {
		name: string;
		description: string;
		source: "builtin" | "user" | "project";
	}

	function parseAgentFrontmatter(content: string): { name?: string; description?: string; disabled?: boolean } {
		// Accept `---\n` and `---\r\n` separators.
		const head = content.startsWith("---\r\n") ? 5 : content.startsWith("---\n") ? 4 : -1;
		if (head === -1) return {};
		const rest = content.slice(head);
		const closeMatch = rest.match(/(^|\n)---(\r?\n|$)/);
		if (!closeMatch || closeMatch.index === undefined) return {};
		const block = rest.slice(0, closeMatch.index);
		const out: { name?: string; description?: string; disabled?: boolean } = {};
		for (const rawLine of block.split(/\r?\n/)) {
			const line = rawLine.trimEnd();
			if (!line || line.startsWith("#")) continue;
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			const key = line.slice(0, colon).trim();
			let value = line.slice(colon + 1).trim();
			if (value.length >= 2) {
				const first = value[0];
				const last = value[value.length - 1];
				if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
					value = value.slice(1, -1);
				}
			}
			if (key === "name") out.name = value;
			else if (key === "description") out.description = value;
			else if (key === "disabled" && (value === "true" || value === "false")) out.disabled = value === "true";
		}
		return out;
	}

	async function readAgentsFromDir(dir: string, source: DiscoveredAgent["source"]): Promise<DiscoveredAgent[]> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return [];
		}
		const out: DiscoveredAgent[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			let content: string;
			try {
				content = await readFile(join(dir, entry), "utf8");
			} catch {
				continue;
			}
			const meta = parseAgentFrontmatter(content);
			if (meta.disabled === true) continue;
			const name = meta.name || basename(entry, ".md");
			out.push({ name, description: meta.description ?? "", source });
		}
		return out;
	}

	async function findNearestProjectRoot(cwd: string): Promise<string | null> {
		let dir = cwd;
		while (true) {
			for (const marker of [".pi", ".agents"]) {
				try {
					const s = await stat(join(dir, marker));
					if (s.isDirectory()) return dir;
				} catch {
					// not present — try next marker
				}
			}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}

	// Cached at startup. pi installs npm extensions to the npm-global root, but
	// the exact path varies (~/.npm-global/lib/node_modules, /usr/lib/..., etc).
	// We resolve once via `npm root -g` so prod systemd installs (which run as
	// root and may use a different prefix) find pi-subagents/agents reliably.
	let cachedNpmGlobalRoot: string | undefined | null;
	async function getNpmGlobalRoot(): Promise<string | undefined> {
		if (cachedNpmGlobalRoot !== undefined) return cachedNpmGlobalRoot ?? undefined;
		try {
			const result = await pi.exec("npm", ["root", "-g"], { timeout: 5000 });
			const out = (result.stdout ?? "").trim();
			cachedNpmGlobalRoot = out || null;
			return cachedNpmGlobalRoot ?? undefined;
		} catch {
			cachedNpmGlobalRoot = null;
			return undefined;
		}
	}

	async function discoverAgents(cwd: string): Promise<DiscoveredAgent[]> {
		const home = homedir();
		const projectRoot = await findNearestProjectRoot(cwd);

		// Order encodes precedence: later entries override earlier ones (so
		// project agents shadow user, user shadow builtin).
		const dirs: Array<{ path: string; source: DiscoveredAgent["source"] }> = [];

		const npmGlobalRoot = await getNpmGlobalRoot();
		const builtinCandidates = [
			npmGlobalRoot ? join(npmGlobalRoot, "pi-subagents", "agents") : undefined,
			join(home, ".npm-global", "lib", "node_modules", "pi-subagents", "agents"),
			"/usr/local/lib/node_modules/pi-subagents/agents",
			"/usr/lib/node_modules/pi-subagents/agents",
		].filter((p): p is string => typeof p === "string");
		for (const candidate of builtinCandidates) {
			dirs.push({ path: candidate, source: "builtin" });
		}

		dirs.push({ path: join(home, ".pi", "agent", "agents"), source: "user" });
		dirs.push({ path: join(home, ".agents"), source: "user" });

		if (projectRoot) {
			dirs.push({ path: join(projectRoot, ".agents"), source: "project" });
			dirs.push({ path: join(projectRoot, ".pi", "agents"), source: "project" });
		}

		const dedup = new Map<string, DiscoveredAgent>();
		for (const { path, source } of dirs) {
			for (const agent of await readAgentsFromDir(path, source)) {
				dedup.set(agent.name, agent);
			}
		}

		return Array.from(dedup.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	// pi's built-in slash commands are NOT returned by pi.getCommands() — that
	// only lists extension-registered commands, prompt templates, and skills.
	// Mirrored from @mariozechner/pi-coding-agent/dist/core/slash-commands.js so
	// the Telegram menu surfaces the full command set users see in the pi TUI.
	const PI_BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
		{ name: "settings", description: "Open settings menu" },
		{ name: "model", description: "Select model" },
		{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
		{ name: "export", description: "Export session (HTML or JSONL)" },
		{ name: "import", description: "Import and resume a session from a JSONL file" },
		{ name: "share", description: "Share session as a secret GitHub gist" },
		{ name: "copy", description: "Copy last agent message to clipboard" },
		{ name: "name", description: "Set session display name" },
		{ name: "session", description: "Show session info and stats" },
		{ name: "changelog", description: "Show changelog entries" },
		{ name: "hotkeys", description: "Show all keyboard shortcuts" },
		{ name: "fork", description: "Create a new fork from a previous user message" },
		{ name: "clone", description: "Duplicate the current session at the current position" },
		{ name: "tree", description: "Navigate session tree (switch branches)" },
		{ name: "login", description: "Configure provider authentication" },
		{ name: "logout", description: "Remove provider authentication" },
		{ name: "new", description: "Start a new session" },
		{ name: "compact", description: "Manually compact the session context" },
		{ name: "resume", description: "Resume a different session" },
		{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
		{ name: "quit", description: "Quit pi" },
	];

	function buildTelegramCommandList(agents: DiscoveredAgent[]): {
		payload: Array<{ command: string; description: string }>;
		reverseMap: Map<string, string>;
		agentCommandMap: Map<string, string>;
	} {
		const seen = new Set<string>();
		const payload: Array<{ command: string; description: string }> = [];
		const reverseMap = new Map<string, string>();
		const agentCommandMap = new Map<string, string>();

		const addEntry = (originalName: string, description: string): void => {
			const tgName = sanitizeTelegramCommandName(originalName);
			if (!tgName || seen.has(tgName)) return;
			const desc = (description ?? "pi command").slice(0, 256);
			payload.push({ command: tgName, description: desc });
			reverseMap.set(tgName, originalName);
			seen.add(tgName);
		};

		// Telegram conventions plus Telegram-only handlers — these always run from Telegram.
		payload.push({ command: "start", description: "Pair this Telegram account with the bot" });
		payload.push({ command: "help", description: "Show Telegram bridge help" });
		payload.push({ command: "stop", description: "Abort the current pi turn" });
		for (const e of payload) seen.add(e.command);

		// pi's built-ins (model, compact, new, fork, …)
		for (const cmd of PI_BUILTIN_COMMANDS) {
			if (payload.length >= 100) break;
			addEntry(cmd.name, cmd.description);
		}

		// Extension-registered commands and prompt templates (skips skills — they use `:`).
		for (const cmd of pi.getCommands()) {
			if (payload.length >= 100) break;
			if (cmd.source === "skill") continue;
			if (cmd.name.includes(":")) continue;
			addEntry(cmd.name, cmd.description ?? "pi command");
		}

		// Subagent shortcuts: `/run_<agent>` so Telegram's slash autocomplete
		// surfaces every agent as the user types `/run`. The dispatcher routes
		// these to the flag picker rather than pi.executeCommand.
		const sourceLabel: Record<DiscoveredAgent["source"], string> = {
			builtin: "builtin",
			user: "user",
			project: "project",
		};
		for (const agent of agents) {
			if (payload.length >= 100) break;
			const tgName = sanitizeTelegramCommandName(`run_${agent.name}`);
			if (!tgName || seen.has(tgName)) continue;
			const baseDesc = agent.description ? `: ${agent.description}` : "";
			const desc = `Run ${agent.name} (${sourceLabel[agent.source]})${baseDesc}`.slice(0, 256);
			payload.push({ command: tgName, description: desc });
			seen.add(tgName);
			agentCommandMap.set(tgName, agent.name);
		}

		return { payload, reverseMap, agentCommandMap };
	}

	async function syncTelegramCommands(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken) return;
		const agents = await discoverAgents(process.cwd());
		const { payload, reverseMap, agentCommandMap } = buildTelegramCommandList(agents);
		activeReverseMap = reverseMap;
		activeAgentCommandMap = agentCommandMap;
		const hash = JSON.stringify(payload);
		if (hash === lastSyncedCommandsHash) return;
		try {
			await callTelegram("setMyCommands", {
				commands: payload,
				scope: { type: "all_private_chats" },
			});
			lastSyncedCommandsHash = hash;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateStatus(ctx, `setMyCommands failed: ${message}`);
		}
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function getMessageText(message: AgentMessage): string {
		return formatMessageWithThinking(extractMessageBlocks(message));
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
			} catch {
				// ignore
			}
		}
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		state.flushTimer = undefined;
		const text = state.pendingText.trim();
		if (!text || text === state.lastSentText) return;
		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		if (state.messageId === undefined) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
			state.messageId = sent.message_id;
			state.mode = "message";
			state.lastSentText = truncated;
			return;
		}
		await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		state.mode = "message";
		state.lastSentText = truncated;
	}

	function schedulePreviewFlush(chatId: number): void {
		if (!previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId);
		}, PREVIEW_THROTTLE_MS);
	}

	async function finalizePreview(chatId: number): Promise<boolean> {
		const state = previewState;
		if (!state) return false;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
			return false;
		}
		if (state.mode === "draft") {
			await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: finalText });
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		return state.messageId !== undefined;
	}

	async function sendTextReply(chatId: number, _replyToMessageId: number, text: string): Promise<number | undefined> {
		const chunks = chunkParagraphs(text);
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: chunk,
			});
			lastMessageId = sent.message_id;
		}
		return lastMessageId;
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const formatted = formatMessageWithThinking(extractMessageBlocks(messages[i]));
			return { text: formatted || undefined, stopReason, errorMessage };
		}
		return {};
	}

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video) {
				const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	// Synchronous abort for use inside session_shutdown / nested runtime calls.
	// Awaiting pollingPromise from a handler that is itself running on the
	// polling task deadlocks (e.g. pi.executeCommand("new") triggers
	// session_shutdown which would then wait for the very poll iteration that
	// dispatched it). Detach the controller and let the loop exit on its next
	// signal-checked callTelegram.
	function abortPollingForShutdown(): void {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
			}
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.");
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`);
				},
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
			return;
		}

		if (lower === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			lines.push(`Thinking: ${THINKING_LEVEL_LABELS[pi.getThinkingLevel()]}`);
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
			return;
		}

		if (lower === "/model" || lower.startsWith("/model ")) {
			const modelArg = lower === "/model" ? undefined : rawText.slice(7).trim();
			const chatId = firstMessage.chat.id;
			const messageId = firstMessage.message_id;

			if (modelArg) {
				// Try to match and switch to a model
				const allModels = ctx.modelRegistry.getAvailable();
				const currentRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;

				// Try exact provider/id match first
				let matched = allModels.find(
					(m) => `${m.provider}/${m.id}`.toLowerCase() === modelArg.toLowerCase(),
				);

				// Then try exact id match
				if (!matched) {
					matched = allModels.find((m) => m.id.toLowerCase() === modelArg.toLowerCase());
				}

				// Then try partial match
				if (!matched) {
					const partial = allModels.filter(
						(m) =>
							m.provider.toLowerCase().includes(modelArg) ||
							m.id.toLowerCase().includes(modelArg) ||
							(m.name && m.name.toLowerCase().includes(modelArg)),
					);

					if (partial.length === 0) {
						await sendTextReply(
							chatId,
							messageId,
							`No models matching "${modelArg}".\n\nSend /model to list all available models.`,
						);
						return;
					}

					if (partial.length > 1) {
						const lines = [
							`Multiple models match "${modelArg}":`,
							...partial.map((m) => {
								const ref = `${m.provider}/${m.id}`;
								const suffix = m.name && m.name !== m.id ? ` (${m.name})` : "";
								return `  ${ref}${suffix}`;
							}),
							`\nBe more specific, e.g. /model ${partial[0].provider}/${partial[0].id}`,
						];
						await sendTextReply(chatId, messageId, lines.join("\n"));
						return;
					}

					matched = partial[0];
				}

				const ref = `${matched.provider}/${matched.id}`;
				if (ref === currentRef) {
					await sendTextReply(chatId, messageId, `Already using ${ref}.`);
					return;
				}

				const ok = await pi.setModel(matched);
				if (ok) {
					const nameSuffix = matched.name && matched.name !== matched.id ? ` (${matched.name})` : "";
					await sendTextReply(
						chatId,
						messageId,
						`Switched to ${ref}${nameSuffix}.`,
					);
				} else {
					await sendTextReply(
						chatId,
						messageId,
						`Cannot switch to ${ref} — no API key configured.`,
					);
				}
			} else {
				// Show model picker with inline keyboard
				const allModels = ctx.modelRegistry.getAvailable();
				const currentRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;

				if (allModels.length === 0) {
					await sendTextReply(chatId, messageId, "No models available.");
					return;
				}

				// Build model entries for the picker
				const modelEntries = allModels.map((m) => ({
					ref: `${m.provider}/${m.id}`,
					provider: m.provider,
					id: m.id,
					name: m.name && m.name !== m.id ? m.name : undefined,
				}));

	

				// Store for callback handling
				pendingModelSelections.set(chatId, {
					models: modelEntries,
					messageId,
					page: 0,
				});

				// Render page 0
				await renderModelPicker(chatId, messageId, modelEntries, currentRef, 0);
			}
			return;
		}

		if (lower === "/thinking" || lower.startsWith("/thinking ")) {
			const arg = lower === "/thinking" ? undefined : rawText.slice("/thinking ".length).trim();
			const chatId = firstMessage.chat.id;
			const messageId = firstMessage.message_id;
			const currentLevel = pi.getThinkingLevel();
			if (arg) {
				const requested = arg.toLowerCase() as ThinkingLevel;
				if (!THINKING_LEVELS.includes(requested)) {
					await sendTextReply(
						chatId,
						messageId,
						`Unknown level "${arg}". Pick one of: ${THINKING_LEVELS.join(", ")}.`,
					);
					return;
				}
				try {
					pi.setThinkingLevel(requested);
				} catch (error) {
					const m = error instanceof Error ? error.message : String(error);
					await sendTextReply(chatId, messageId, `Failed to set thinking level: ${m}`);
					return;
				}
				const after = pi.getThinkingLevel();
				const change = currentLevel === after ? "" : ` (was ${THINKING_LEVEL_LABELS[currentLevel]})`;
				const note =
					after === requested
						? `Thinking level: ${THINKING_LEVEL_LABELS[after]}${change}.`
						: `Requested ${THINKING_LEVEL_LABELS[requested]}; the current model only supports up to ${THINKING_LEVEL_LABELS[after]}${change}.`;
				await sendTextReply(chatId, messageId, note);
				return;
			}
			pendingThinkingSelections.set(chatId, { messageId });
			await renderThinkingPicker(chatId, messageId, currentLevel);
			return;
		}

		if (lower === "/new") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot start a new session while pi is busy. Send \"stop\" first.");
				return;
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Starting a new pi session...");
			await pi.executeCommand("new");
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Send me a message and I will forward it to pi.\nTap the Menu button to browse pi's slash commands — type / to filter.\nRunnable from Telegram: /model, /thinking, /status, /compact, /new, /stop (or "stop"), /restart, /health, /cron. Other menu entries are listed for reference; run them from the pi TUI.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
			}
			return;
		}

		if (lower.startsWith("/")) {
			const tgName = lower.slice(1).split(/[\s@]/)[0];

			// `/run_<agent>` shortcut — show the flag picker, then dispatch
			// `/run <agent> <task> [--bg] [--fork]` once the user selects a mode.
			const agentName = activeAgentCommandMap.get(tgName);
			if (agentName) {
				const argSpace = rawText.indexOf(" ");
				const taskHint = argSpace === -1 ? "" : rawText.slice(argSpace + 1).trim();
				await renderAgentRunPicker(
					firstMessage.chat.id,
					firstMessage.message_id,
					agentName,
					taskHint,
				);
				return;
			}

			const piName = activeReverseMap.get(tgName);
			if (piName) {
				// Commands that need an interactive TUI selector or dialog can't run
				// headless via pi.executeCommand — opening a picker on a Telegram-only
				// machine would just hang. Block them up-front.
				const TUI_ONLY = new Set([
					"settings", "login", "logout", "scoped-models",
					"fork", "clone", "tree", "resume", "import",
					"hotkeys", "changelog",
				]);
				if (TUI_ONLY.has(piName)) {
					await sendTextReply(
						firstMessage.chat.id,
						firstMessage.message_id,
						`/${piName} needs the pi TUI (interactive picker or dialog). Run it directly from pi.`,
					);
					return;
				}

				const argSpace = rawText.indexOf(" ");
				const cmdArgs = argSpace === -1 ? "" : rawText.slice(argSpace + 1).trim();
				const exec = (pi as { executeCommand?: (name: string, args?: string) => Promise<boolean> }).executeCommand;
				if (typeof exec !== "function") {
					await sendTextReply(
						firstMessage.chat.id,
						firstMessage.message_id,
						`/${piName}: this pi build doesn't support remote command dispatch. Upgrade pi or run the command from the TUI.`,
					);
					return;
				}
				// /new replaces the session, which loads a fresh extension instance
				// and stops the in-flight Telegram polling we're running on. Send a
				// confirmation up-front so the user gets feedback even if the
				// post-dispatch ack would otherwise race the swap.
				const ackMessage = (name: string): string | undefined => {
					switch (name) {
						case "new": return "✓ Started a new pi session.";
						case "compact": return "✓ Compaction triggered.";
						case "reload": return "✓ Reloaded extensions, skills, and prompts.";
						case "quit": return "✓ Shutting pi down.";
						case "name": return "✓ Session name updated.";
						case "copy": return "✓ Copied the last reply to pi's clipboard.";
						case "share": return "✓ Share triggered — check pi's TUI for the gist URL.";
						case "export": return "✓ Export triggered.";
						case "session": return "✓ Session info shown in pi's TUI.";
						default: return `✓ /${name} done.`;
					}
				};
				// Gateway-aware commands send their own structured replies via
				// `pendingTelegramCommandReply`. Skip the generic ack for them.
				pendingTelegramCommandReply = {
					chatId: firstMessage.chat.id,
					messageId: firstMessage.message_id,
					suppressAck: false,
				};
				try {
					const handled = await exec(piName, cmdArgs);
					const suppressAck = pendingTelegramCommandReply?.suppressAck ?? false;
					if (!handled) {
						await sendTextReply(
							firstMessage.chat.id,
							firstMessage.message_id,
							`/${piName} is no longer registered.`,
						);
					} else if (!suppressAck) {
						const ack = ackMessage(piName);
						if (ack) {
							await sendTextReply(firstMessage.chat.id, firstMessage.message_id, ack);
						}
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await sendTextReply(
						firstMessage.chat.id,
						firstMessage.message_id,
						`/${piName} failed: ${message}`,
					);
				} finally {
					pendingTelegramCommandReply = undefined;
				}
				return;
			}
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, historyTurns);
		queuedTelegramTurns.push(turn);
		if (ctx.isIdle()) {
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(turn.content);
		}
	}

	// Telegram inline keyboard limits: max 8 buttons per column, ~100 buttons total
	const MODEL_PAGE_SIZE = 5;

	function buildModelKeyboard(
		models: Array<{
			ref: string;
			provider: string;
			id: string;
			name?: string;
		}>,
		currentRef: string | null,
		page: number,
	): {
		text: string;
		keyboard: Array<Array<{ text: string; callback_data: string }>>;
	} {
		const totalPages = Math.ceil(models.length / MODEL_PAGE_SIZE);
		const start = page * MODEL_PAGE_SIZE;
		const end = Math.min(start + MODEL_PAGE_SIZE, models.length);
		const pageModels = models.slice(start, end);

		const headerLines = [
			`Models (${page + 1}/${totalPages})`,
			currentRef ? `Current: ${currentRef}` : "Current: none",
			"",
		];

		const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
		for (const m of pageModels) {
			const isCurrent = m.ref === currentRef;
			const label = m.name ? m.name : m.id;
			const prefix = isCurrent ? "✅ " : "  ";
			keyboard.push([{
				text: `${prefix}${label} (${m.provider})`,
				callback_data: `model:${m.ref}`,
			}]);
		}

		if (totalPages > 1) {
			const navRow: Array<{ text: string; callback_data: string }> = [];
			if (page > 0) navRow.push({ text: "⬅️ Prev", callback_data: `modelpage:${page - 1}` });
			if (page < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `modelpage:${page + 1}` });
			if (navRow.length > 0) keyboard.push(navRow);
		}

		keyboard.push([{
			text: "❌ Cancel",
			callback_data: "model:cancel",
		}]);

		const text = headerLines.join("\n");
		return { text, keyboard };
	}

	async function renderModelPicker(
		chatId: number,
		_originalMessageId: number,
		models: Array<{
			ref: string;
			provider: string;
			id: string;
			name?: string;
		}>,
		currentRef: string | null,
		page: number,
		editMessageId?: number,
	): Promise<void> {
		const { text, keyboard } = buildModelKeyboard(models, currentRef, page);

		// Guard: ensure text is never empty (Telegram rejects empty text)
		if (!text || text.trim().length === 0) {
			console.error("[telepi-model] renderModelPicker: text is empty, models=", models.length, "page=", page);
			return;
		}

		try {
			if (editMessageId !== undefined) {
				await callTelegram<TelegramSentMessage>("editMessageText", {
					chat_id: chatId,
					message_id: editMessageId,
					text,
					reply_markup: { inline_keyboard: keyboard },
				});
			} else {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text,
					reply_markup: { inline_keyboard: keyboard },
				});
				const pending = pendingModelSelections.get(chatId);
				if (pending) pending.messageId = sent.message_id;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[telepi-model] renderModelPicker failed:", message, "text=", JSON.stringify(text.substring(0, 100)));
			await sendTextReply(chatId, _originalMessageId, `Failed to show model picker: ${message}`);
		}
	}

	async function replyAndCleanup(
		chatId: number,
		keyboardMessageId: number,
		resultText: string,
	): Promise<void> {
		try {
			await sendTextReply(chatId, keyboardMessageId, resultText);
		} catch (e) {
			console.error("[telepi-model] replyAndCleanup: reply failed:", e);
		}
		// Clean up the keyboard message
		try {
			await callTelegram<any>("deleteMessage", {
				chat_id: chatId,
				message_id: keyboardMessageId,
			});
		} catch {
			// keyboard might already be gone — ignore
		}
	}

	async function handleModelCallback(
		callbackQueryId: string,
		chatId: number,
		keyboardMessageId: number,
		data: string,
		ctx: ExtensionContext,
	): Promise<boolean> {


		try {
			await callTelegram<TelegramCallbackAnswer>("answerCallbackQuery", {
				callback_query_id: callbackQueryId,
			});
		} catch {
			// ignore
		}

		const pending = pendingModelSelections.get(chatId);
		if (!pending) return false;

		const currentRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;

		if (data === "model:cancel") {
			pendingModelSelections.delete(chatId);
			await replyAndCleanup(chatId, keyboardMessageId, "Model picker cancelled.");
			return true;
		}

		if (data.startsWith("modelpage:")) {
			const newPage = parseInt(data.slice(10), 10);
			if (!isNaN(newPage) && newPage >= 0) {
				pending.page = newPage;
				try {
					await renderModelPicker(chatId, keyboardMessageId, pending.models, currentRef, newPage, keyboardMessageId);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await sendTextReply(chatId, keyboardMessageId, `Failed to render page: ${message}`);
				}
			}
			return true;
		}

		if (data.startsWith("model:")) {
			const ref = data.slice(6);
			const matched = pending.models.find((m) => m.ref === ref);
			if (!matched) return true;

			const model = ctx.modelRegistry.find(matched.provider, matched.id);
			if (!model) {
				pendingModelSelections.delete(chatId);
				await replyAndCleanup(chatId, keyboardMessageId, `Model ${ref} not found.`);
				return true;
			}

			if (ref === currentRef) {
				pendingModelSelections.delete(chatId);
				await replyAndCleanup(chatId, keyboardMessageId, `Already using ${ref}.`);
				return true;
			}

			const ok = await pi.setModel(model);
			if (ok) {
				pendingModelSelections.delete(chatId);
				const nameSuffix = model.name && model.name !== model.id ? ` (${model.name})` : "";
				await replyAndCleanup(chatId, keyboardMessageId, `Switched to ${ref}${nameSuffix}.`);
			} else {
				await replyAndCleanup(chatId, keyboardMessageId, `Cannot switch to ${ref} — no API key.`);
			}
			return true;
		}

		return false;
	}

	function buildThinkingKeyboard(currentLevel: ThinkingLevel): {
		text: string;
		keyboard: Array<Array<{ text: string; callback_data: string }>>;
	} {
		const headerLines = [
			"Thinking level",
			`Current: ${THINKING_LEVEL_LABELS[currentLevel]}`,
			"",
			"pi clamps the choice to whatever the active model supports.",
		];
		// Two columns: less spammy than 6 vertical buttons, still tappable on mobile.
		const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
		for (let i = 0; i < THINKING_LEVELS.length; i += 2) {
			const row: Array<{ text: string; callback_data: string }> = [];
			for (const level of THINKING_LEVELS.slice(i, i + 2)) {
				const isCurrent = level === currentLevel;
				const label = `${isCurrent ? "✅ " : ""}${THINKING_LEVEL_LABELS[level]}`;
				row.push({ text: label, callback_data: `thinking:${level}` });
			}
			keyboard.push(row);
		}
		keyboard.push([{ text: "❌ Cancel", callback_data: "thinking:cancel" }]);
		return { text: headerLines.join("\n"), keyboard };
	}

	async function renderThinkingPicker(
		chatId: number,
		_originalMessageId: number,
		currentLevel: ThinkingLevel,
		editMessageId?: number,
	): Promise<void> {
		const { text, keyboard } = buildThinkingKeyboard(currentLevel);
		try {
			if (editMessageId !== undefined) {
				await callTelegram<TelegramSentMessage>("editMessageText", {
					chat_id: chatId,
					message_id: editMessageId,
					text,
					reply_markup: { inline_keyboard: keyboard },
				});
			} else {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text,
					reply_markup: { inline_keyboard: keyboard },
				});
				const pending = pendingThinkingSelections.get(chatId);
				if (pending) pending.messageId = sent.message_id;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await sendTextReply(chatId, _originalMessageId, `Failed to show thinking picker: ${message}`);
		}
	}

	async function handleThinkingCallback(
		callbackQueryId: string,
		chatId: number,
		keyboardMessageId: number,
		data: string,
	): Promise<boolean> {
		try {
			await callTelegram<TelegramCallbackAnswer>("answerCallbackQuery", { callback_query_id: callbackQueryId });
		} catch {
			// ignore
		}

		const pending = pendingThinkingSelections.get(chatId);
		if (!pending) return false;

		if (data === "thinking:cancel") {
			pendingThinkingSelections.delete(chatId);
			await replyAndCleanup(chatId, keyboardMessageId, "Thinking-level picker cancelled.");
			return true;
		}

		if (!data.startsWith("thinking:")) return false;
		const requested = data.slice("thinking:".length) as ThinkingLevel;
		if (!THINKING_LEVELS.includes(requested)) return true;

		const before = pi.getThinkingLevel();
		try {
			pi.setThinkingLevel(requested);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pendingThinkingSelections.delete(chatId);
			await replyAndCleanup(chatId, keyboardMessageId, `Failed to set thinking level: ${message}`);
			return true;
		}
		const after = pi.getThinkingLevel();
		pendingThinkingSelections.delete(chatId);
		const note =
			after === requested
				? `Thinking level: ${THINKING_LEVEL_LABELS[after]}.`
				: `Requested ${THINKING_LEVEL_LABELS[requested]}; the current model only supports up to ${THINKING_LEVEL_LABELS[after]}.`;
		const change = before === after ? "" : ` (was ${THINKING_LEVEL_LABELS[before]})`;
		await replyAndCleanup(chatId, keyboardMessageId, `${note}${change}`);
		return true;
	}

	// ========================================================================
	// /run_<agent> flow: Telegram-only flag picker that turns the synthetic
	// `/run_<agent>` command into the equivalent of `/run <agent> <task> [--bg]
	// [--fork]` against pi-subagents. Task can be supplied inline after the
	// command; if missing, we ask via the bridged ctx.ui.input prompt.
	// ========================================================================

	interface PendingAgentRun {
		agent: string;
		taskHint: string;
		keyboardMessageId: number;
		originalReplyToId: number;
	}
	// chatId -> pending agent run awaiting a flag selection
	const pendingAgentRuns = new Map<number, PendingAgentRun>();

	interface PendingAgentTaskInput {
		agent: string;
		bg: boolean;
		fork: boolean;
		originalReplyToId: number;
		promptMessageId: number;
	}
	// chatId -> pending agent run awaiting the task text in the user's NEXT
	// message. We can't reuse pendingUiPrompts because that's awaited from
	// agent code; here we're inside the polling loop, so awaiting the prompt
	// would deadlock — it would block the same handler that needs to read the
	// next update.
	const pendingAgentTaskInputs = new Map<number, PendingAgentTaskInput>();

	// FIFO queue of /run dispatches awaiting their `subagent-slash-result`
	// message_end so we can route the rendered output back to the originating
	// chat. pi-subagents emits the result as a custom message into the pi
	// session — perfect for the TUI, invisible to Telegram unless we forward
	// it. We match by agent name in dispatch order; concurrent /runs of the
	// same agent from different chats would collide, but that's a corner case
	// we accept until pi-subagents exposes a request id at dispatch time.
	interface PendingSubagentDispatch {
		chatId: number;
		replyToId: number;
		agent: string;
		dispatchedAt: number;
	}
	const pendingSubagentDispatches: PendingSubagentDispatch[] = [];

	function buildAgentRunKeyboard(agent: string, taskHint: string): {
		text: string;
		keyboard: Array<Array<{ text: string; callback_data: string }>>;
	} {
		const headerLines = [`Run ${agent}`];
		if (taskHint) {
			const preview = taskHint.length > 200 ? `${taskHint.slice(0, 197)}…` : taskHint;
			headerLines.push(`Task: ${preview}`);
		} else {
			headerLines.push("Task: (will be asked next)");
		}
		headerLines.push("", "Pick execution mode:");
		const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
			[{ text: "▶️ Run", callback_data: "agentrun:plain" }],
			[{ text: "🔁 Run --bg (background)", callback_data: "agentrun:bg" }],
			[{ text: "🔀 Run --fork (forked context)", callback_data: "agentrun:fork" }],
			[{ text: "🔁🔀 Run --bg --fork", callback_data: "agentrun:bgfork" }],
			[{ text: "❌ Cancel", callback_data: "agentrun:cancel" }],
		];
		return { text: headerLines.join("\n"), keyboard };
	}

	async function renderAgentRunPicker(
		chatId: number,
		originalReplyToId: number,
		agent: string,
		taskHint: string,
	): Promise<void> {
		// Replace any prior picker for this chat — only one outstanding flag
		// selection at a time. Stale keyboards become harmless once the state
		// they referenced is gone.
		const prev = pendingAgentRuns.get(chatId);
		if (prev) {
			pendingAgentRuns.delete(chatId);
			void stripKeyboardWithReply(chatId, prev.keyboardMessageId, "Cancelled — superseded by a new /run picker.");
		}

		const { text, keyboard } = buildAgentRunKeyboard(agent, taskHint);
		try {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text,
				reply_markup: { inline_keyboard: keyboard },
			});
			pendingAgentRuns.set(chatId, {
				agent,
				taskHint,
				keyboardMessageId: sent.message_id,
				originalReplyToId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await sendTextReply(chatId, originalReplyToId, `Failed to show /run picker: ${message}`);
		}
	}

	async function handleAgentRunCallback(
		callbackQueryId: string,
		chatId: number,
		keyboardMessageId: number,
		data: string,
	): Promise<boolean> {
		if (!data.startsWith("agentrun:")) return false;
		try {
			await callTelegram<TelegramCallbackAnswer>("answerCallbackQuery", { callback_query_id: callbackQueryId });
		} catch {
			// ignore
		}

		const pending = pendingAgentRuns.get(chatId);
		if (!pending || pending.keyboardMessageId !== keyboardMessageId) {
			// Stale or wrong picker — claim the callback so the generic "Unknown
			// action" fallback doesn't fire.
			void stripKeyboardWithReply(chatId, keyboardMessageId, "Picker no longer active.");
			return true;
		}

		const choice = data.slice("agentrun:".length);
		if (choice === "cancel") {
			pendingAgentRuns.delete(chatId);
			void stripKeyboardWithReply(chatId, keyboardMessageId, `❌ /run ${pending.agent} cancelled.`);
			return true;
		}

		let bg = false;
		let fork = false;
		switch (choice) {
			case "plain": break;
			case "bg": bg = true; break;
			case "fork": fork = true; break;
			case "bgfork": bg = true; fork = true; break;
			default: return true;
		}

		pendingAgentRuns.delete(chatId);
		const flagsLabel = [bg ? "--bg" : null, fork ? "--fork" : null].filter(Boolean).join(" ") || "no flags";

		if (pending.taskHint) {
			void stripKeyboardWithReply(chatId, keyboardMessageId, `▶️ Running ${pending.agent} (${flagsLabel})…`);
			await dispatchAgentRun(chatId, pending.originalReplyToId, pending.agent, pending.taskHint, bg, fork);
			return true;
		}

		// No inline task — ask for it. We CANNOT await user input from inside the
		// callback handler because the polling loop's `await handleUpdate(...)`
		// is what would deliver that input. Awaiting here would deadlock until
		// the prompt timer fires (5min), at which point /run cancels and the
		// user's task message dispatches as a normal chat turn — exactly the
		// symptom we hit. Instead, set state and return; the next text message
		// in this chat is consumed by handleAuthorizedTelegramMessage.
		void stripKeyboardWithReply(chatId, keyboardMessageId, `${pending.agent} (${flagsLabel}) — awaiting task…`);

		const evicted = pendingAgentTaskInputs.get(chatId);
		if (evicted) {
			pendingAgentTaskInputs.delete(chatId);
			void sendTextReply(chatId, evicted.promptMessageId, "Cancelled — superseded by a new /run.");
		}

		try {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: `Task for ${pending.agent}:\nReply with the task, or send /cancel to abort.`,
			});
			pendingAgentTaskInputs.set(chatId, {
				agent: pending.agent,
				bg,
				fork,
				originalReplyToId: pending.originalReplyToId,
				promptMessageId: sent.message_id,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await sendTextReply(chatId, pending.originalReplyToId, `Failed to ask for task: ${message}`);
		}
		return true;
	}

	// Returns true if the message was consumed as the task for a pending /run.
	// Called from handleAuthorizedTelegramMessage before normal dispatch.
	function tryConsumeAgentTaskInput(message: TelegramMessage): boolean {
		const pending = pendingAgentTaskInputs.get(message.chat.id);
		if (!pending) return false;
		const text = (message.text ?? message.caption ?? "").trim();
		if (!text) return false; // photo/doc with no caption — don't consume; let user reply with text
		pendingAgentTaskInputs.delete(message.chat.id);
		if (text === "/cancel") {
			void sendTextReply(message.chat.id, pending.originalReplyToId, `Cancelled /run ${pending.agent}.`);
			return true;
		}
		// Fire-and-forget: dispatchAgentRun internally awaits pi.executeCommand,
		// which for non-bg runs can take a while. Don't block the polling loop.
		void dispatchAgentRun(message.chat.id, pending.originalReplyToId, pending.agent, text, pending.bg, pending.fork);
		return true;
	}

	async function dispatchAgentRun(
		chatId: number,
		originalReplyToId: number,
		agent: string,
		task: string,
		bg: boolean,
		fork: boolean,
	): Promise<void> {
		const argsParts = [agent];
		if (task) argsParts.push(task);
		if (bg) argsParts.push("--bg");
		if (fork) argsParts.push("--fork");
		const args = argsParts.join(" ");

		try {
			const exec = (pi as { executeCommand?: (name: string, args?: string) => Promise<boolean> }).executeCommand;
			if (typeof exec !== "function") {
				await sendTextReply(chatId, originalReplyToId, "/run: this pi build doesn't support remote command dispatch.");
				return;
			}
			// Record before exec so the message_end listener can match — the
			// subagent posts message_start within ms of dispatch.
			pendingSubagentDispatches.push({ chatId, replyToId: originalReplyToId, agent, dispatchedAt: Date.now() });
			pendingTelegramCommandReply = { chatId, messageId: originalReplyToId, suppressAck: false };
			try {
				const handled = await exec("run", args);
				if (!handled) {
					// Drop the entry we just queued — no result will arrive.
					const idx = pendingSubagentDispatches.findIndex((d) => d.chatId === chatId && d.agent === agent);
					if (idx !== -1) pendingSubagentDispatches.splice(idx, 1);
					await sendTextReply(chatId, originalReplyToId, "/run is not registered (is pi-subagents installed?).");
				}
				// On success, forwardSubagentSlashResult sends the result when the
				// message_end event fires — no extra ack here.
			} finally {
				pendingTelegramCommandReply = undefined;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await sendTextReply(chatId, originalReplyToId, `/run ${agent} failed: ${message}`);
		}
	}

	// pi-subagents posts the rendered result as a `subagent-slash-result`
	// custom message twice: first with status "running" (just the task echoed
	// back) at message_start, then again at message_end with the full output.
	// We forward the second one. Returns the chat info to send to, plus the
	// formatted text — null if this isn't ours or the message is the in-flight
	// "running" placeholder.
	function takeSubagentResultPayload(message: AgentMessage): {
		chatId: number;
		replyToId: number;
		text: string;
	} | null {
		if (message.role !== "custom") return null;
		const cm = message as { customType?: string; content?: unknown; details?: unknown };
		if (cm.customType !== "subagent-slash-result") return null;

		const details = cm.details as
			| { result?: { details?: { results?: Array<{ agent?: string; exitCode?: number; finalOutput?: string; error?: string; outputReference?: { message?: string } }> } } }
			| undefined;
		const first = details?.result?.details?.results?.[0];
		if (!first) return null;
		// The "running" placeholder lacks exitCode / finalOutput. Only forward
		// the terminal one.
		if (first.exitCode === undefined && !first.error) return null;

		const agent = first.agent ?? "";
		const idx = pendingSubagentDispatches.findIndex((d) => d.agent === agent);
		if (idx === -1) return null;
		const [pending] = pendingSubagentDispatches.splice(idx, 1);

		const header = first.exitCode === 0 ? `✅ /run ${agent}` : `❌ /run ${agent} (exit ${first.exitCode ?? "?"})`;
		const body = first.error
			? first.error
			: (first.finalOutput?.trim() || first.outputReference?.message || "(no output)");
		return { chatId: pending.chatId, replyToId: pending.replyToId, text: `${header}\n\n${body}` };
	}

	// ========================================================================
	// ctx.ui bridge: route confirm/select/input/custom calls through Telegram
	// when an extension prompts during a Telegram-driven turn. Falls through to
	// the original UI when no Telegram turn is active (e.g. /telegram-setup
	// invoked at the pi TUI). `custom` (full TUI overlays) is rejected with a
	// note instead of hanging headlessly.
	// ========================================================================

	function getActiveTelegramChatId(): number | undefined {
		return activeTelegramTurn?.chatId ?? queuedTelegramTurns[0]?.chatId;
	}

	async function stripKeyboardWithReply(chatId: number, messageId: number, replacementText: string): Promise<void> {
		// Edit the prompt message to show what was answered and drop the keyboard
		// in one round-trip. If the edit fails (message gone, etc.), we let it go
		// — leftover buttons are harmless once we stop responding to them.
		try {
			await callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text: replacementText });
		} catch {
			// ignore
		}
	}

	function evictPendingUiPrompt(chatId: number, replacementText: string): void {
		const prev = pendingUiPrompts.get(chatId);
		if (!prev) return;
		clearTimeout(prev.timer);
		pendingUiPrompts.delete(chatId);
		if (prev.kind === "confirm") prev.resolve(false);
		else prev.resolve(undefined);
		if (prev.kind !== "input") {
			void stripKeyboardWithReply(chatId, prev.messageId, replacementText);
		}
	}

	function cancelAllPendingUiPrompts(replacementText: string): void {
		for (const chatId of Array.from(pendingUiPrompts.keys())) {
			evictPendingUiPrompt(chatId, replacementText);
		}
	}

	async function uiConfirmViaTelegram(chatId: number, title: string, message: string): Promise<boolean> {
		evictPendingUiPrompt(chatId, "Cancelled — superseded by a new prompt.");
		const text = message ? `${title}\n\n${message}` : title;
		const keyboard = [[
			{ text: "✅ Yes", callback_data: "uip:confirm:y" },
			{ text: "❌ No", callback_data: "uip:confirm:n" },
		]];
		let sent: TelegramSentMessage;
		try {
			sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text,
				reply_markup: { inline_keyboard: keyboard },
			});
		} catch {
			return false;
		}
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				const cur = pendingUiPrompts.get(chatId);
				if (!cur || cur.messageId !== sent.message_id) return;
				pendingUiPrompts.delete(chatId);
				void stripKeyboardWithReply(chatId, sent.message_id, `${text}\n\n⏱ Timed out — answered No.`);
				resolve(false);
			}, UI_PROMPT_TIMEOUT_MS);
			pendingUiPrompts.set(chatId, { kind: "confirm", chatId, messageId: sent.message_id, resolve, timer });
		});
	}

	async function uiSelectViaTelegram(chatId: number, title: string, options: string[]): Promise<string | undefined> {
		evictPendingUiPrompt(chatId, "Cancelled — superseded by a new prompt.");
		// Telegram caps inline keyboards at 100 buttons; reserve one for cancel.
		const limited = options.slice(0, 96);
		const rows: Array<Array<{ text: string; callback_data: string }>> = [];
		for (let i = 0; i < limited.length; i++) {
			rows.push([{ text: limited[i].slice(0, 64), callback_data: `uip:select:${i}` }]);
		}
		rows.push([{ text: "❌ Cancel", callback_data: "uip:cancel" }]);
		let sent: TelegramSentMessage;
		const text = title || "Choose an option:";
		try {
			sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text,
				reply_markup: { inline_keyboard: rows },
			});
		} catch {
			return undefined;
		}
		return new Promise<string | undefined>((resolve) => {
			const timer = setTimeout(() => {
				const cur = pendingUiPrompts.get(chatId);
				if (!cur || cur.messageId !== sent.message_id) return;
				pendingUiPrompts.delete(chatId);
				void stripKeyboardWithReply(chatId, sent.message_id, `${text}\n\n⏱ Timed out — selection cancelled.`);
				resolve(undefined);
			}, UI_PROMPT_TIMEOUT_MS);
			pendingUiPrompts.set(chatId, { kind: "select", chatId, messageId: sent.message_id, options: limited, resolve, timer });
		});
	}

	async function uiInputViaTelegram(chatId: number, title: string, placeholder?: string): Promise<string | undefined> {
		evictPendingUiPrompt(chatId, "Cancelled — superseded by a new prompt.");
		const lines = [title];
		if (placeholder) lines.push(`(e.g. ${placeholder})`);
		lines.push("Reply with your answer, or send /cancel.");
		let sent: TelegramSentMessage;
		try {
			sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: lines.join("\n"),
			});
		} catch {
			return undefined;
		}
		return new Promise<string | undefined>((resolve) => {
			const timer = setTimeout(() => {
				const cur = pendingUiPrompts.get(chatId);
				if (!cur || cur.messageId !== sent.message_id) return;
				pendingUiPrompts.delete(chatId);
				void sendTextReply(chatId, sent.message_id, "⏱ Timed out — input cancelled.").catch(() => {});
				resolve(undefined);
			}, UI_PROMPT_TIMEOUT_MS);
			pendingUiPrompts.set(chatId, { kind: "input", chatId, messageId: sent.message_id, resolve, timer });
		});
	}

	async function handleUiPromptCallback(callbackQueryId: string, chatId: number, _keyboardMessageId: number, data: string): Promise<boolean> {
		if (!data.startsWith("uip:")) return false;
		try {
			await callTelegram<TelegramCallbackAnswer>("answerCallbackQuery", { callback_query_id: callbackQueryId });
		} catch {
			// ignore
		}
		const pending = pendingUiPrompts.get(chatId);
		if (!pending) return true;
		if (data === "uip:cancel") {
			clearTimeout(pending.timer);
			pendingUiPrompts.delete(chatId);
			void stripKeyboardWithReply(chatId, pending.messageId, "Cancelled.");
			if (pending.kind === "confirm") pending.resolve(false);
			else pending.resolve(undefined);
			return true;
		}
		if (pending.kind === "confirm" && (data === "uip:confirm:y" || data === "uip:confirm:n")) {
			clearTimeout(pending.timer);
			pendingUiPrompts.delete(chatId);
			const yes = data === "uip:confirm:y";
			void stripKeyboardWithReply(chatId, pending.messageId, yes ? "✅ Yes." : "❌ No.");
			pending.resolve(yes);
			return true;
		}
		if (pending.kind === "select" && data.startsWith("uip:select:")) {
			const idx = Number.parseInt(data.slice("uip:select:".length), 10);
			if (Number.isFinite(idx) && idx >= 0 && idx < pending.options.length) {
				clearTimeout(pending.timer);
				pendingUiPrompts.delete(chatId);
				const choice = pending.options[idx];
				void stripKeyboardWithReply(chatId, pending.messageId, `Selected: ${choice}`);
				pending.resolve(choice);
				return true;
			}
		}
		// Stale or malformed payload — claim it so the generic "Unknown action"
		// path doesn't fire and confuse the user.
		return true;
	}

	function consumePendingInput(chatId: number, text: string): boolean {
		const pending = pendingUiPrompts.get(chatId);
		if (!pending || pending.kind !== "input") return false;
		clearTimeout(pending.timer);
		pendingUiPrompts.delete(chatId);
		const trimmed = text.trim();
		if (trimmed === "/cancel") {
			void sendTextReply(chatId, pending.messageId, "Input cancelled.").catch(() => {});
			pending.resolve(undefined);
		} else {
			pending.resolve(text);
		}
		return true;
	}

	function pendingPromptKind(chatId: number): PendingUiPrompt["kind"] | undefined {
		return pendingUiPrompts.get(chatId)?.kind;
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
		// If a /run_<agent> picker is awaiting the task text, this message is
		// the task — consume it and dispatch /run instead of starting a chat
		// turn. Checked before pendingUiPrompts because the agent-task input
		// uses its own non-blocking state machine (see comment near
		// pendingAgentTaskInputs).
		if (tryConsumeAgentTaskInput(message)) return;

		// If an extension is awaiting ui.input for this chat, the next plain-text
		// message becomes the answer and is NOT dispatched as a new turn. Photos,
		// docs, etc. fall through to normal dispatch — the prompt keeps waiting.
		const pendingKind = pendingPromptKind(message.chat.id);
		if (pendingKind === "input") {
			const text = message.text ?? message.caption;
			if (typeof text === "string" && text.length > 0) {
				if (consumePendingInput(message.chat.id, text)) return;
			}
		} else if (pendingKind === "confirm" || pendingKind === "select") {
			// User typed instead of tapping a button — nudge, then let dispatch run
			// as normal so they don't lose the message they sent.
			await sendTextReply(
				message.chat.id,
				message.message_id,
				pendingKind === "confirm"
					? "(Tip: tap Yes or No on the prompt above.)"
					: "(Tip: tap an option on the prompt above.)",
			);
		}

		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] };
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, ctx);
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		// Handle inline keyboard callbacks (model picker)
		if (update.callback_query) {
			const cq = update.callback_query;
			if (cq.from && cq.from.id !== config.allowedUserId) return;

			if (cq.data && cq.message) {
				if (cq.data.startsWith("uip:")) {
					const handled = await handleUiPromptCallback(
						cq.id,
						cq.message.chat.id,
						cq.message.message_id,
						cq.data,
					);
					if (handled) return;
				}
				if (cq.data.startsWith("thinking:")) {
					const handled = await handleThinkingCallback(
						cq.id,
						cq.message.chat.id,
						cq.message.message_id,
						cq.data,
					);
					if (handled) return;
				}
				if (cq.data.startsWith("agentrun:")) {
					const handled = await handleAgentRunCallback(
						cq.id,
						cq.message.chat.id,
						cq.message.message_id,
						cq.data,
					);
					if (handled) return;
				}
				const handled = await handleModelCallback(
					cq.id,
					cq.message.chat.id,
					cq.message.message_id,
					cq.data,
					ctx,
				);
				if (handled) return;
			}
			// Answer unhandled callbacks to clear loading state
			try {
				await callTelegram<TelegramCallbackAnswer>("answerCallbackQuery", {
					callback_query_id: cq.id,
					text: "Unknown action.",
					show_alert: false,
				});
			} catch {
				// ignore
			}
			return;
		}

		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
			await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
		}

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
			return;
		}

		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig(config);
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message", "callback_query"],
					},
					{ signal },
				);
				for (const update of updates) {
					// If a previous update in this batch caused a session swap (e.g. /new
					// via pi.executeCommand), our session_shutdown handler aborts this
					// signal. Bail before touching the now-stale ctx — the new session's
					// own polling loop will fetch this update from offset+1.
					if (signal.aborted) break;
					config.lastUpdateId = update.update_id;
					await writeConfig(config);
					await handleUpdate(update, ctx);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken || pollingPromise) return;
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			updateStatus(ctx);
		});
		updateStatus(ctx);
		void syncTelegramCommands(ctx);
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			if (!activeTelegramTurn) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			config = await readConfig();
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await stopPolling();
			updateStatus(ctx);
		},
	});

	// ========================================================================
	// Gateway commands: /restart, /health, /cron
	// ========================================================================
	//
	// These commands talk to the supervisor (scripts/gateway.ts) via filesystem
	// sentinels in runtime/control/ and the heartbeat at runtime/gateway.health.
	// They do NOT need an RPC channel back to the gateway — the gateway watches
	// the control dir at 1Hz and the cron file's mtime each tick.

	const replyToCommand = async (text: string): Promise<void> => {
		const reply = pendingTelegramCommandReply;
		if (!reply) return;
		reply.suppressAck = true;
		await sendTextReply(reply.chatId, reply.messageId, text);
	};

	pi.registerCommand("restart", {
		description: "Restart the bot via the gateway supervisor",
		handler: async (_args, _ctx) => {
			const paths = resolveGatewayPaths();
			const health = await readGatewayHealth(paths);
			if (!health) {
				await replyToCommand(
					"Gateway not running — start the bot via ./start.sh so the supervisor is in charge.",
				);
				return;
			}
			try {
				await mkdir(paths.controlDir, { recursive: true });
				await writeFile(join(paths.controlDir, "restart"), `${new Date().toISOString()}\n`, "utf8");
				await replyToCommand("Restart requested. Bot will respawn shortly.");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await replyToCommand(`Restart request failed: ${msg}`);
			}
		},
	});

	pi.registerCommand("health", {
		description: "Show gateway + bot health",
		handler: async (_args, _ctx) => {
			const paths = resolveGatewayPaths();
			const health = await readGatewayHealth(paths);
			await replyToCommand(formatHealth(health));
		},
	});

	pi.registerCommand("cron", {
		description: "Manage scheduled tasks (list | add <id> <expr5> <prompt> | rm <id> | run <id> | enable <id> | disable <id>)",
		handler: async (args, _ctx) => {
			const paths = resolveGatewayPaths();
			const trimmed = args.trim();
			if (!trimmed || trimmed === "list") {
				const file = await readCronFileSafe(paths);
				await replyToCommand(formatCronList(file));
				return;
			}
			const [verb, ...rest] = trimmed.split(/\s+/);
			const file = await readCronFileSafe(paths);
			switch (verb) {
				case "add": {
					if (rest.length < 7) {
						await replyToCommand("Usage: /cron add <id> <m> <h> <dom> <mon> <dow> <prompt>");
						return;
					}
					const [id, ...tail] = rest;
					if (!isValidCronTaskId(id)) {
						await replyToCommand("Bad task id. Allowed: lowercase alnum, _ or - (max 64).");
						return;
					}
					if (file.tasks.some((t) => t.id === id)) {
						await replyToCommand(`Task "${id}" already exists. Use /cron rm ${id} first.`);
						return;
					}
					const schedule = tail.slice(0, 5).join(" ");
					if (!isValidCronExpr(schedule)) {
						await replyToCommand(`Bad cron expression: "${schedule}". Standard 5 fields: m h dom mon dow.`);
						return;
					}
					const prompt = tail.slice(5).join(" ").trim();
					if (!prompt) {
						await replyToCommand("Empty prompt. Provide the prompt after the 5 cron fields.");
						return;
					}
					file.tasks.push({ id, schedule, prompt, enabled: true });
					await writeCronFileAtomic(paths, file);
					await replyToCommand(`Added task "${id}" (${schedule}). Edit runtime/cron.json to tweak.`);
					return;
				}
				case "rm": {
					const id = rest[0];
					if (!id) { await replyToCommand("Usage: /cron rm <id>"); return; }
					const before = file.tasks.length;
					file.tasks = file.tasks.filter((t) => t.id !== id);
					if (file.tasks.length === before) { await replyToCommand(`No task "${id}".`); return; }
					await writeCronFileAtomic(paths, file);
					await replyToCommand(`Removed task "${id}".`);
					return;
				}
				case "run": {
					const id = rest[0];
					if (!id) { await replyToCommand("Usage: /cron run <id>"); return; }
					if (!file.tasks.some((t) => t.id === id)) { await replyToCommand(`No task "${id}".`); return; }
					try {
						await mkdir(paths.controlDir, { recursive: true });
						await writeFile(join(paths.controlDir, `run-${id}`), `${new Date().toISOString()}\n`, "utf8");
						await replyToCommand(`Triggered "${id}". Result will arrive when the task finishes.`);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await replyToCommand(`Trigger failed: ${msg}`);
					}
					return;
				}
				case "enable":
				case "disable": {
					const id = rest[0];
					if (!id) { await replyToCommand(`Usage: /cron ${verb} <id>`); return; }
					const task = file.tasks.find((t) => t.id === id);
					if (!task) { await replyToCommand(`No task "${id}".`); return; }
					task.enabled = verb === "enable";
					await writeCronFileAtomic(paths, file);
					await replyToCommand(`Task "${id}" ${verb}d.`);
					return;
				}
				default:
					await replyToCommand(
						"Unknown subcommand. Use: list | add <id> <expr5> <prompt> | rm <id> | run <id> | enable <id> | disable <id>",
					);
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		if (config.botToken && !pollingPromise) { await startPolling(ctx); }
		updateStatus(ctx);
		void syncTelegramCommands(ctx);
		installCtxUiBridge(ctx.ui);
	});

	// Wraps confirm/select/input/custom on the runner-shared uiContext so every
	// extension sees the bridged versions without each having to opt in. The
	// originals run when no Telegram turn is in flight (e.g. /telegram-setup at
	// the pi TUI). Idempotent — pi can re-fire session_start on /reload, and
	// the runtime may swap the uiContext underneath us, so we re-check via a
	// hidden marker on the object.
	function installCtxUiBridge(ui: ExtensionUIContext): void {
		const tagged = ui as ExtensionUIContext & { __telegramBridgeInstalled?: boolean };
		if (tagged.__telegramBridgeInstalled) return;

		const origConfirm = ui.confirm.bind(ui);
		const origSelect = ui.select.bind(ui);
		const origInput = ui.input.bind(ui);
		const origCustom = ui.custom.bind(ui);

		const wrappedConfirm: ExtensionUIContext["confirm"] = async (title, message, opts) => {
			const chatId = getActiveTelegramChatId();
			if (chatId !== undefined) return uiConfirmViaTelegram(chatId, title, message);
			return origConfirm(title, message, opts);
		};
		const wrappedSelect: ExtensionUIContext["select"] = async (title, options, opts) => {
			const chatId = getActiveTelegramChatId();
			if (chatId !== undefined) return uiSelectViaTelegram(chatId, title, options);
			return origSelect(title, options, opts);
		};
		const wrappedInput: ExtensionUIContext["input"] = async (title, placeholder, opts) => {
			const chatId = getActiveTelegramChatId();
			if (chatId !== undefined) return uiInputViaTelegram(chatId, title, placeholder);
			return origInput(title, placeholder, opts);
		};
		const wrappedCustom: ExtensionUIContext["custom"] = async (factory, options) => {
			const chatId = getActiveTelegramChatId();
			if (chatId !== undefined) {
				await sendTextReply(
					chatId,
					activeTelegramTurn?.replyToMessageId ?? 0,
					"An extension tried to open a TUI overlay, which Telegram can't render. Resolving as cancelled.",
				);
				// `Promise<never>` is assignable to `Promise<T>`; calling code that
				// treats undefined as cancelled handles this gracefully.
				return undefined as never;
			}
			return origCustom(factory, options);
		};

		ui.confirm = wrappedConfirm;
		ui.select = wrappedSelect;
		ui.input = wrappedInput;
		ui.custom = wrappedCustom;
		tagged.__telegramBridgeInstalled = true;
	}

	pi.on("session_shutdown", async (_event, _ctx) => {
		queuedTelegramTurns = [];
		cancelAllPendingUiPrompts("Cancelled — pi session ended.");
		for (const [chatId, pending] of Array.from(pendingAgentRuns.entries())) {
			void stripKeyboardWithReply(chatId, pending.keyboardMessageId, "Cancelled — pi session ended.");
		}
		pendingAgentRuns.clear();
		for (const [chatId, pending] of Array.from(pendingAgentTaskInputs.entries())) {
			void sendTextReply(chatId, pending.promptMessageId, "Cancelled — pi session ended.");
		}
		pendingAgentTaskInputs.clear();
		pendingSubagentDispatches.length = 0;
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		if (activeTelegramTurn) {
			await clearPreview(activeTelegramTurn.chatId);
		}
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		// Use the synchronous abort variant: this handler may run *on* the polling
		// task itself (when a Telegram-dispatched command triggers a session
		// replacement), so awaiting pollingPromise here would self-deadlock.
		abortPollingForShutdown();
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
				startTypingLoop(ctx);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
			await finalizePreview(activeTelegramTurn.chatId);
		}
		previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!previewState) {
			previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}
		previewState.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	pi.on("message_end", async (event, _ctx) => {
		const payload = takeSubagentResultPayload(event.message);
		if (!payload) return;
		await sendTextReply(payload.chatId, payload.replyToId, payload.text);
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = activeTelegramTurn;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) return;

		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await clearPreview(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			await clearPreview(turn.chatId);
			await sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}

		const finalText = assistant.text;
		if (previewState) {
			previewState.pendingText = finalText ?? previewState.pendingText;
		}

		if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			const finalized = await finalizePreview(turn.chatId);
			if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		} else {
			await clearPreview(turn.chatId);
			if (finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		}

		await sendQueuedAttachments(turn);

		if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
			const nextTurn = queuedTelegramTurns[0];
			startTypingLoop(ctx, nextTurn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(nextTurn.content);
		}
	});
}
