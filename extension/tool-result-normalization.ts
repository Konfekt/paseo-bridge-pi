type ToolExecutionEndEvent = {
	type: "tool_execution_end";
	isError?: boolean;
	result?: unknown;
	[key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNoDetails(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(isRecord(value) && Object.keys(value).length === 0)
	);
}

function textBlocks(value: unknown): string | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const text: string[] = [];
	for (const part of value) {
		if (
			!isRecord(part) ||
			part.type !== "text" ||
			typeof part.text !== "string"
		)
			return null;
		text.push(part.text);
	}
	const joined = text.join("\n");
	return joined.length > 0 ? joined : null;
}

function textOnlyFailedResult(result: unknown): string | null {
	if (!isRecord(result)) return null;
	if (Object.keys(result).some((key) => key !== "content" && key !== "details"))
		return null;
	if (!hasNoDetails(result.details)) return null;
	return textBlocks(result.content);
}

function structuredShellErrorResult(result: unknown): string | null {
	if (!isRecord(result)) return null;
	if (
		Object.keys(result).some(
			(key) => !["content", "details", "structuredContent"].includes(key),
		)
	)
		return null;
	if (!hasNoDetails(result.details) || !isRecord(result.structuredContent))
		return null;

	const structured = result.structuredContent;
	if (
		Object.keys(structured).some(
			(key) =>
				!["output", "exit_code", "truncated", "wall_time_seconds"].includes(
					key,
				),
		)
	)
		return null;
	if (
		typeof structured.output !== "string" ||
		typeof structured.exit_code !== "number"
	)
		return null;
	if (
		structured.truncated !== undefined &&
		typeof structured.truncated !== "boolean"
	)
		return null;
	if (
		structured.wall_time_seconds !== undefined &&
		typeof structured.wall_time_seconds !== "number"
	)
		return null;

	// The text content is the readable shell output; structuredContent repeats it
	// alongside metadata. Keep only that copy when it corresponds to the output.
	const content = textBlocks(result.content);
	if (!content || (structured.output.length > 0 && !content.includes(structured.output)))
		return null;
	return content;
}

/**
 * Unwrap failed Pi text-block results, including Bash results that duplicate
 * readable output in structuredContent. Preserve unrelated structured failures.
 */
export function normalizePiEventForPaseo(event: unknown): unknown {
	if (
		!isRecord(event) ||
		event.type !== "tool_execution_end" ||
		event.isError !== true
	)
		return event;
	const text =
		textOnlyFailedResult(event.result) ??
		(event.toolName === "bash"
			? structuredShellErrorResult(event.result)
			: null);
	if (text === null) return event;
	return { ...(event as ToolExecutionEndEvent), result: text };
}
