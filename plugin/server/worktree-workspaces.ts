import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** Inclusive read-only discovery: background workers still have exact workspace IDs.
 * Older hosts reject the flag at the SDK boundary and have no background inventory.
 * Never downgrade authentication, transport or incomplete-inventory failures.
 */
export async function listWorktreeWorkspaces(context: PluginHandlerContext, projectId: string, cursor?: string) {
	const list = (includeBackground: boolean) => context.paseo.workspaces.list({
		filter: { projectId, ...(includeBackground ? { includeBackground: true } : {}) },
		page: { limit: 200, cursor },
	});
	try { return await list(true); }
	catch (error) {
		if (!(error instanceof Error) || error.message !== "Update the host to use background workspaces.") throw error;
		return list(false);
	}
}
