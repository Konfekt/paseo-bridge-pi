import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Shared host/workspace restoration hints, NOT a synchronized active selection.
 * Paseo has no device-local settings or workspace panel params. Only explicit
 * Work opens write hints; already mounted clients never follow another client.
 * Session identity deliberately excludes runtime epoch (reconnects may change it).
 */
export const workSourceSettings = defineSettings({
	id: "work-source",
	scope: "host",
	version: 1,
	schema: z.object({
		sources: z.array(z.object({
			hostId: z.string().min(1),
			workspaceId: z.string().min(1),
			agentId: z.string().min(1),
			sessionId: z.string().min(1),
		}).strict()).default([]),
	}).strict(),
});
