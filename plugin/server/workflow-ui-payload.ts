/** Current producers may include explicit completion/cleanup metadata. This UI
 * does not implement that lifecycle. Discard only those known additive fields;
 * all remaining data still goes through the existing strict workflow schema.
 * In particular, completion is never treated as merge evidence/removal consent.
 */
export function workflowUiPayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const { worktreeCompletions: _completions, worktreeCompletionError: _error, ...snapshot } = value as Record<string, unknown>;
	if (snapshot.capabilities && typeof snapshot.capabilities === "object" && !Array.isArray(snapshot.capabilities)) {
		const { ownedWorktreeCompletion: _completion, ...capabilities } = snapshot.capabilities as Record<string, unknown>;
		snapshot.capabilities = capabilities;
	}
	return snapshot;
}
