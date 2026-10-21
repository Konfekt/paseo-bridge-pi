// Quota response mapping adapted from Paseo's codex-usage-source (Apache-2.0).
// See ../client/PASEO-LICENSE. Session binding and transport guards are bridge-specific.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
	toneFromUsedPct,
	balanceToneFromRemaining,
	unavailable,
	windowFromReportedDuration,
	type UsageReport,
} from "@getpaseo/plugin/server/usage";
import { fetchCompanionUsage } from "./companion-usage";
import { accountControlsSnapshotSchema } from "../shared/account-controls";
import {
	callAccountControls,
	readAccountControlsDescriptor,
	validateAccountControlsDescriptor,
} from "./account-controls-transport";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const inputSchema = z
	.object({ agentId: z.string().min(1).max(256), handle: z.string().uuid() })
	.strict();
const windowSchema = z.object({
	used_percent: z.coerce.number().finite().nonnegative().nullish(),
	reset_at: z.coerce.number().finite().nonnegative().nullish(),
	limit_window_seconds: z.coerce.number().finite().nullish(),
});
const rateLimitSchema = z.object({
	primary_window: windowSchema.nullish(),
	secondary_window: windowSchema.nullish(),
});
const responseSchema = z.object({
	plan_type: z.string().max(256).optional(),
	rate_limit: rateLimitSchema.nullish(),
	additional_rate_limits: z
		.array(
			z.object({
				limit_name: z.string().max(256).optional(),
				metered_feature: z.string().max(256).optional(),
				rate_limit: rateLimitSchema.nullish(),
			}),
		)
		.max(100)
		.nullish(),
	code_review_rate_limit: rateLimitSchema.nullish(),
	credits: z
		.object({ balance: z.coerce.number().finite().optional() })
		.nullish(),
});
function usageWindows(
	rate: z.infer<typeof rateLimitSchema> | null | undefined,
	scope?: { id: string; label: string },
) {
	return (["primary_window", "secondary_window"] as const).flatMap((slot) => {
		const value = rate?.[slot];
		if (!value) return [];
		const primary = slot === "primary_window";
		return [
			windowFromReportedDuration({
				durationSeconds: value.limit_window_seconds ?? null,
				unknown: {
					id: primary ? "unknown_primary" : "unknown_secondary",
					label: primary ? "Primary limit" : "Secondary limit",
					shortLabel: "",
				},
				scope,
				summary: !scope,
				utilizationPct: value.used_percent,
				resetsAt:
					value.reset_at == null
						? null
						: new Date(value.reset_at * 1000).toISOString(),
				tone: toneFromUsedPct(value.used_percent),
			}),
		];
	});
}
const credentialSchema = z.object({
	type: z.literal("oauth").optional().default("oauth"),
	access: z.string().min(1).max(65536),
	expires: z.number().finite(),
	accountId: z.string().min(1).max(256).optional(),
});
const text = (value: unknown): string | undefined =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 256 &&
	!/[\p{Cc}\p{Cf}]/u.test(value)
		? value
		: undefined;

async function readPrivateJson(
	dir: string,
	file: "auth.json" | "pi-accounts.json" | "pi-usage.json",
) {
	if (!isAbsolute(dir)) throw new Error("Invalid account directory");
	const directory = await lstat(dir);
	// Readable directory names are harmless; other users must not be able to replace files.
	if (
		!directory.isDirectory() ||
		directory.isSymbolicLink() ||
		directory.mode & 0o022 ||
		(process.getuid && directory.uid !== process.getuid())
	)
		throw new Error("Unsafe account directory");
	const settings = file === "pi-usage.json";
	const path = settings ? await realpath(join(dir, file)) : join(dir, file);
	const nixSettings = settings && path.startsWith("/nix/store/");
	const handle = await open(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const stat = await handle.stat();
		const max = 1024 * 1024;
		if (
			!stat.isFile() ||
			stat.mode & (settings ? 0o022 : 0o077) ||
			stat.size > max ||
			(process.getuid && stat.uid !== (nixSettings ? 0 : process.getuid()))
		)
			throw new Error("Unsafe account store");
		const buffer = Buffer.alloc(max + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		if (size > max) throw new Error("Oversized account store");
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} finally {
		await handle.close();
	}
}

async function readCredential(dir: string, name: string) {
	const store = await readPrivateJson(dir, "pi-accounts.json");
	if (
		store?.version !== 1 ||
		!Object.hasOwn(store?.providers?.openai?.accounts ?? {}, name)
	)
		throw new Error("Missing selected account");
	return credentialSchema.parse(store.providers.openai.accounts[name]);
}

type UnavailableReason =
	| "default-oauth"
	| "api-key"
	| "identity"
	| "companion-disabled";
class UsageUnavailable extends Error {
	constructor(readonly reason: UnavailableReason) {
		super(reason);
	}
}

async function selection(agentId: string) {
	const descriptor = await readAccountControlsDescriptor(agentId);
	if (!validateAccountControlsDescriptor(descriptor, agentId))
		throw new Error("Selection unavailable");
	const snapshot = accountControlsSnapshotSchema.parse(
		await callAccountControls(descriptor, {
			operation: "snapshot",
			sessionId: descriptor.sessionId,
		}),
	);
	const current = await readAccountControlsDescriptor(agentId);
	if (
		!validateAccountControlsDescriptor(current, agentId) ||
		JSON.stringify(current) !== JSON.stringify(descriptor) ||
		snapshot.sessionId !== descriptor.sessionId ||
		snapshot.serviceEpoch !== descriptor.serviceEpoch
	)
		throw new Error("Selection changed");
	if (
		snapshot.usage.nativeRegistrationKey &&
		snapshot.usage.status === "local-binding-confirmed" &&
		(snapshot.defaultSelected || snapshot.activationStatus === "active")
	) {
		return {
			descriptor,
			snapshot,
			account: snapshot.accounts.find(
				(item) =>
					item.id === snapshot.currentAccountId && item.authKind === "oauth",
			),
		};
	}
	if (
		snapshot.defaultSelected &&
		snapshot.usage.status === "local-binding-confirmed" &&
		snapshot.usage.effectiveCredential === "chatgpt-grant-configured"
	)
		throw new UsageUnavailable(
			snapshot.usage.nativeRegistrationVersion === 1
				? "identity"
				: "default-oauth",
		);
	if (snapshot.usage.effectiveCredential === "api-key-configured")
		throw new UsageUnavailable("api-key");
	if (
		snapshot.usage.status === "local-binding-confirmed" &&
		!snapshot.usage.accountKey
	)
		throw new UsageUnavailable("identity");
	if (
		snapshot.defaultSelected ||
		!snapshot.currentAccountId ||
		snapshot.activationStatus !== "active" ||
		snapshot.usage.status !== "local-binding-confirmed" ||
		snapshot.usage.effectiveCredential !== "chatgpt-grant-matched-refreshed" ||
		!snapshot.usage.accountKey
	)
		throw new Error("No verified named OAuth binding");
	const account = snapshot.accounts.find(
		(item) =>
			item.id === snapshot.currentAccountId && item.authKind === "oauth",
	);
	if (!account) throw new Error("Selected account unavailable");
	return { descriptor, snapshot, account };
}

async function binding(agentId: string, dir: string) {
	const before = await selection(agentId);
	if (before.snapshot.usage.nativeRegistrationKey)
		return companionBinding(agentId, dir, before);
	if (!before.account) throw new Error("Selected account unavailable");
	const credential = await readCredential(dir, before.account.id);
	const after = await selection(agentId);
	const again = await readCredential(dir, before.account.id);
	if (
		JSON.stringify(before.descriptor) !== JSON.stringify(after.descriptor) ||
		before.snapshot.selectionRevision !== after.snapshot.selectionRevision ||
		before.account.id !== after.account?.id ||
		credential.access !== again.access ||
		credential.expires !== again.expires ||
		credential.accountId !== again.accountId
	)
		throw new Error("Binding changed");
	const claims = JSON.parse(
		Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString(
			"utf8",
		),
	);
	const claimId =
		text(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id) ??
		text(claims?.chatgpt_account_id);
	if (claimId && credential.accountId && claimId !== credential.accountId)
		throw new Error("Conflicting account identity");
	const accountId = claimId ?? credential.accountId;
	const subject = text(
		claims?.sub ?? claims?.["https://api.openai.com/auth"]?.chatgpt_user_id,
	);
	const accountKey = hash(JSON.stringify(["openai", accountId, subject]));
	if (
		!accountId ||
		!subject ||
		before.snapshot.usage.accountKey !== accountKey ||
		after.snapshot.usage.accountKey !== before.snapshot.usage.accountKey
	)
		throw new Error("Account identity unavailable");
	const label =
		text(claims?.["https://api.openai.com/profile"]?.email) ??
		text(claims?.email) ??
		before.account.label;
	// Credential-derived fingerprint stays private; public locators contain only a random handle.
	const fingerprint = hash(
		JSON.stringify([
			dir,
			before.descriptor,
			before.snapshot.selectionRevision,
			before.account.id,
			credential,
		]),
	);
	return {
		credential,
		accountId,
		label,
		fingerprint,
		key: accountKey,
		clientId: undefined as string | undefined,
	};
}

const nativeSchema = credentialSchema.extend({
	clientId: z.string().min(1).max(512),
	scopes: z
		.array(z.string())
		.refine((scopes) => scopes.includes("chatgpt.tokens.use.direct")),
});
async function companionBinding(
	agentId: string,
	dir: string,
	before: Awaited<ReturnType<typeof selection>>,
) {
	let settings;
	try {
		settings = await readPrivateJson(dir, "pi-usage.json");
	} catch {
		throw new UsageUnavailable("companion-disabled");
	}
	if (settings.openaiUseCodexUsage !== true)
		throw new UsageUnavailable("companion-disabled");
	const load = async () => {
		const auth = await readPrivateJson(dir, "auth.json");
		const rawNative = before.snapshot.defaultSelected
			? auth.openai
			: (await readPrivateJson(dir, "pi-accounts.json"))?.providers?.openai
					?.accounts?.[before.snapshot.currentAccountId!];
		const native = nativeSchema.parse(rawNative);
		const credential = credentialSchema.parse(auth["openai-codex"]);
		const nativeClaims = JSON.parse(
			Buffer.from(native.access.split(".")[1] ?? "", "base64url").toString(
				"utf8",
			),
		);
		const subject = text(nativeClaims?.sub);
		if (
			!subject ||
			hash(JSON.stringify(["openai-native", native.clientId, subject])) !==
				before.snapshot.usage.nativeRegistrationKey
		)
			throw new Error("Native registration changed");
		const claims = JSON.parse(
			Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString(
				"utf8",
			),
		);
		const accountId = text(
			claims?.["https://api.openai.com/auth"]?.chatgpt_account_id,
		);
		if (!accountId || credential.accountId !== accountId)
			throw new Error("Invalid companion account");
		if (native.expires <= Date.now() || credential.expires <= Date.now())
			throw new Error("Companion or native login expired");
		return {
			native,
			credential,
			accountId,
			label:
				text(claims?.["https://api.openai.com/profile"]?.email) ??
				text(claims?.email),
		};
	};
	const first = await load();
	const after = await selection(agentId);
	const second = await load();
	if (
		JSON.stringify(before.descriptor) !== JSON.stringify(after.descriptor) ||
		before.snapshot.selectionRevision !== after.snapshot.selectionRevision ||
		before.snapshot.currentAccountId !== after.snapshot.currentAccountId ||
		before.snapshot.usage.nativeRegistrationKey !==
			after.snapshot.usage.nativeRegistrationKey ||
		JSON.stringify(first) !== JSON.stringify(second) ||
		(await readPrivateJson(dir, "pi-usage.json")).openaiUseCodexUsage !== true
	)
		throw new Error("Companion binding changed");
	return {
		credential: first.credential,
		accountId: first.accountId,
		label: first.label ?? "Codex companion",
		clientId: first.native.clientId,
		key: hash(
			JSON.stringify([
				"openai-companion",
				before.snapshot.usage.nativeRegistrationKey,
				first.accountId,
			]),
		),
		fingerprint: hash(
			JSON.stringify([
				dir,
				before.descriptor,
				before.snapshot.selectionRevision,
				first,
			]),
		),
	};
}

type Locator = {
	handle: string;
	dir: string;
	fingerprint: string;
	touched: number;
	verified: boolean;
	reason?: UnavailableReason;
};
const missing = (reason?: UnavailableReason) =>
	unavailable({
		kind: "no_quota",
		detail:
			reason === "default-oauth"
				? "Reload Pi to publish the native registration proof required for companion usage."
				: reason === "companion-disabled"
					? "Companion usage is off. Enable openaiUseCodexUsage in pi-usage.json only for matching OpenAI/Codex accounts and workspaces."
					: reason === "api-key"
						? "Subscription quota is unavailable for an API-key login. Use OpenAI's usage settings for billing usage."
						: reason === "identity"
							? "The current model's native OpenAI registration could not be verified. Custom authentication/origins or an unavailable grant cannot use companion quotas."
							: "The current Pi account service or binding is unavailable. No other login's usage is substituted.",
	});

/** Read-only, session-selected OAuth quota. Never refreshes or switches credentials. */
export function registerSessionAccountUsage(server: PluginServerContext) {
	const locators = new Map<string, Locator>();
	server.registerUsageSource({
		id: "pi-selected-openai",
		label: "OpenAI",
		input: inputSchema,
		async discover(scope) {
			if (
				scope.kind !== "session" ||
				scope.provider !== "pi" ||
				!/^(openai|idle-guard)\//.test(scope.model ?? "")
			)
				return [];
			const agentId = scope.env.PASEO_AGENT_ID;
			if (!agentId) return [];
			const dir =
				scope.env.PI_CODING_AGENT_DIR ||
				join(scope.env.HOME || homedir(), ".pi", "agent");
			for (const [id, item] of locators)
				if (Date.now() - item.touched > 30 * 60_000) locators.delete(id);
			let found: Awaited<ReturnType<typeof binding>> | undefined;
			let reason: UnavailableReason | undefined;
			try {
				found = await binding(agentId, dir);
			} catch (error) {
				if (error instanceof UsageUnavailable) reason = error.reason;
			}
			const fingerprint =
				found?.fingerprint ?? `unavailable:${dir}:${reason ?? "binding"}`;
			const previous = locators.get(agentId);
			const locator: Locator =
				previous?.fingerprint === fingerprint
					? previous
					: {
							handle: randomUUID(),
							dir,
							fingerprint,
							touched: Date.now(),
							verified: Boolean(found),
							reason,
						};
			locator.touched = Date.now();
			locators.delete(agentId);
			locators.set(agentId, locator);
			while (locators.size > 1000)
				locators.delete(locators.keys().next().value!);
			return [
				{
					key: found?.key ?? hash(`unavailable\0${agentId}`),
					...(found ? { label: found.label } : {}),
					harness: "Pi",
					sessionOnly: !found || Boolean(found.clientId),
					input: { agentId, handle: locator.handle },
				},
			];
		},
		async fetch(raw): Promise<UsageReport> {
			try {
				const input = inputSchema.parse(raw);
				const locator = locators.get(input.agentId);
				if (!locator || locator.handle !== input.handle) return missing();
				if (!locator.verified) return missing(locator.reason);
				const check = async () => {
					const current = await binding(input.agentId, locator.dir);
					if (
						locators.get(input.agentId) !== locator ||
						current.fingerprint !== locator.fingerprint
					)
						throw new Error("Binding changed");
					return current;
				};
				const current = await check();
				if (current.clientId)
					return await fetchCompanionUsage(
						{
							clientId: current.clientId,
							access: current.credential.access,
							accountId: current.accountId,
						},
						async () => {
							await check();
						},
					);
				if (current.credential.expires <= Date.now())
					return unavailable({
						kind: "expired",
						expiresAt: new Date(current.credential.expires).toISOString(),
						refreshedBy: "Pi account login",
					});
				const response = await fetch(
					"https://chatgpt.com/backend-api/wham/usage",
					{
						headers: {
							Authorization: `Bearer ${current.credential.access}`,
							Accept: "application/json",
							"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
							"ChatGPT-Account-Id": current.accountId,
						},
						redirect: "error",
						signal: AbortSignal.timeout(8000),
					},
				);
				await check();
				if (response.status === 401 || response.status === 403) {
					await response.body?.cancel();
					return unavailable({
						kind: "rejected",
						status: response.status,
						refreshedBy: "Pi account login",
					});
				}
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error("Quota service unavailable");
				}
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Missing quota response");
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						size += chunk.value.length;
						if (size > 256 * 1024) throw new Error("Oversized quota response");
						chunks.push(chunk.value);
					}
				} finally {
					await reader.cancel().catch(() => {});
				}
				const body = responseSchema.parse(
					JSON.parse(Buffer.concat(chunks).toString("utf8")),
				);
				await check();
				const windows = [
					...usageWindows(body.rate_limit),
					...(body.additional_rate_limits ?? []).flatMap((limit) => {
						const identity = limit.metered_feature || limit.limit_name;
						return identity
							? usageWindows(limit.rate_limit, {
									id: `limit:${encodeURIComponent(identity)}`,
									label: limit.limit_name || identity,
								})
							: [];
					}),
					...usageWindows(body.code_review_rate_limit, {
						id: "code_review",
						label: "Code review",
					}),
				];
				const balance = body.credits?.balance;
				if (!windows.length && balance === undefined)
					return unavailable({
						kind: "no_quota",
						detail: "The selected account returned no quota information.",
					});
				return {
					status: "available",
					planLabel: body.plan_type,
					windows,
					balances:
						balance === undefined
							? []
							: [
									{
										id: "credits",
										label: "Credits",
										remaining: balance,
										unit: "credits",
										tone: balanceToneFromRemaining(balance),
									},
								],
				};
			} catch (error) {
				return error instanceof UsageUnavailable
					? missing(error.reason)
					: {
							status: "error",
							error:
								"Could not read usage for the selected Pi account. No fallback login was used.",
						};
			}
		},
	});
}
