// Adapted from narumiruna/pi-extensions pi-usage, MIT; see PI-USAGE-LICENSE.
// Companion registration matching is routing validation, not independent same-user proof.
import type { UsageReport, UsageWindow } from "@getpaseo/plugin/server/usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_BYTES = 256 * 1024;
type Input = { clientId: string; access: string; accountId: string };
type Guard = () => Promise<void>;
const object = (value: unknown): Record<string, any> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, any>)
		: undefined;
const percent = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= 100;
function normalize(raw: unknown) {
	const window = object(raw);
	if (
		!window ||
		!percent(window.used_percent) ||
		(window.remaining_percent !== undefined &&
			(!percent(window.remaining_percent) ||
				Math.abs(window.used_percent + window.remaining_percent - 100) > 1)) ||
		!Number.isSafeInteger(window.limit_window_seconds) ||
		window.limit_window_seconds <= 0 ||
		(window.reset_at !== undefined &&
			(!Number.isSafeInteger(window.reset_at) ||
				window.reset_at < 0 ||
				window.reset_at > 8_640_000_000_000))
	)
		throw new Error("Invalid companion usage window");
	return {
		used: window.used_percent as number,
		seconds: window.limit_window_seconds as number,
		reset:
			window.reset_at === undefined
				? null
				: new Date(window.reset_at * 1000).toISOString(),
	};
}
function duration(seconds: number) {
	if (seconds === 604800) return { label: "Weekly", short: "wk" };
	for (const [size, label, short] of [
		[86400, "day", "d"],
		[3600, "hour", "h"],
		[60, "minute", "m"],
		[1, "second", "s"],
	] as const) {
		if (seconds % size === 0)
			return {
				label: `${seconds / size}-${label}`,
				short: `${seconds / size}${short}`,
			};
	}
	throw new Error("Invalid window duration");
}
export async function fetchCompanionUsage(
	{ clientId, access, accountId }: Input,
	guard: Guard,
): Promise<UsageReport> {
	if (!clientId || !access || !accountId)
		throw new Error("Incomplete companion authentication");
	const deadline = Date.now() + 10_000;
	const read = async (url: string) => {
		await guard();
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Companion usage timed out");
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${access}`,
				"ChatGPT-Account-Id": accountId,
				Accept: "application/json",
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
			},
			redirect: "error",
			signal: AbortSignal.timeout(remaining),
		});
		try {
			await guard();
			if (!response.ok)
				throw new Error(
					`Companion usage unavailable (HTTP ${response.status})`,
				);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing companion response");
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.length;
					if (size > MAX_BYTES) throw new Error("Companion response too large");
					chunks.push(chunk.value);
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
			await guard();
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		} finally {
			if (!response.body?.locked) await response.body?.cancel().catch(() => {});
		}
	};
	// Match a complete registration list before requesting any plan data.
	const root = object(await read(`${USAGE_URL}/chatpass/apps`));
	if (
		!root ||
		!Array.isArray(root.items) ||
		root.items.length > 128 ||
		Object.keys(root).some(
			(key) => !["items", "has_more", "next_cursor"].includes(key),
		) ||
		(root.has_more !== undefined && root.has_more !== false) ||
		(root.next_cursor !== undefined &&
			root.next_cursor !== null &&
			root.next_cursor !== "")
	)
		throw new Error("Incomplete companion registration list");
	const apps = root.items.map(object);
	if (apps.some((app) => !app || typeof app.id !== "string" || !app.id.trim()))
		throw new Error("Invalid companion registration identity");
	const matching = apps.filter((app) => app?.id === clientId);
	if (matching.length !== 1)
		throw new Error(
			"Native registration not uniquely matched in companion account",
		);
	const app = matching[0]!;
	if (
		!Array.isArray(app.windows) ||
		!app.windows.length ||
		app.windows.length > 32
	)
		throw new Error("Invalid app usage windows");
	const appWindows = app.windows.map(normalize);
	if (
		app.allowed_usage_percent !== undefined &&
		!percent(app.allowed_usage_percent)
	)
		throw new Error("Invalid app allowance");
	const plan = object(await read(USAGE_URL));
	const rate = object(plan?.rate_limit);
	const resetWindows = new Set<string>();
	const windows: UsageWindow[] = (["primary", "secondary"] as const).flatMap(
		(slot): UsageWindow[] => {
			const raw = rate?.[`${slot}_window`];
			if (raw == null) return [];
			const window = normalize(raw);
			const name = duration(window.seconds);
			resetWindows.add(`${window.seconds}:${window.reset}`);
			return [
				{
					id: `plan:${slot}:${window.seconds}s`,
					label: name.label,
					shortLabel: name.short,
					summary: true,
					usedPct: window.used,
					remainingPct: 100 - window.used,
					resetsAt: window.reset,
					tone:
						window.used > 90 ? "danger" : window.used >= 70 ? "warning" : "ok",
				},
			];
		},
	);
	if (!windows.length) throw new Error("No plan usage windows");
	// Reset-only app windows use Paseo's native formatter, not preformatted dates.
	// Omit duplicate resets and never expose the candidate's hidden app percentages.
	for (const [index, window] of appWindows.entries()) {
		const key = `${window.seconds}:${window.reset}`;
		if (!window.reset || resetWindows.has(key)) continue;
		resetWindows.add(key);
		const name = duration(window.seconds);
		windows.push({
			id: `app:${index}:${window.seconds}s`,
			label: `App · ${name.label}`,
			shortLabel: `App ${name.short}`,
			resetsAt: window.reset,
		});
	}
	await guard();
	return {
		status: "available",
		windows,
		...(typeof plan?.plan_type === "string" && plan.plan_type.length <= 256
			? { planLabel: plan.plan_type }
			: {}),
		details: [
			...(app.allowed_usage_percent === undefined
				? []
				: [
						{
							id: "app-allowance",
							label: "App allowance cap",
							value: `${Math.round(app.allowed_usage_percent)}% of shared plan`,
						},
					]),
			{
				id: "source",
				label: "Source",
				value: "Codex companion (experimental)",
			},
		],
	};
}
