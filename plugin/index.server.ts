import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHandlers, readOperatorDescriptor } from "./server/operator";
import { permissionGateSetRpc, permissionGateStatusRpc } from "./shared/permission-gate";
import { harnessJobsListRpc, harnessJobsOutputRpc, harnessSubagentsListRpc, harnessSubagentReportRpc, harnessStatusRpc } from "./shared/harness-readonly";
import { observabilitySnapshotRpc } from './shared/observability';
import { createHarnessReadOnlyHandlers } from "./server/harness-readonly";
import { createForegroundTasksHandlers } from "./server/foreground-tasks";
import { foregroundTasksRpc, foregroundTasksStatusRpc } from "./shared/foreground-tasks";
import { createAccountControlsHandlers } from "./server/account-controls";
import { accountControlsStatusRpc, accountControlsSwitchRpc } from "./shared/account-controls";

export default function contribute(server: PluginServerContext) {
  const handlers = createHandlers(readOperatorDescriptor);
  server.handle(permissionGateStatusRpc, handlers.status);
  server.handle(permissionGateSetRpc, handlers.set);
  const readonly = createHarnessReadOnlyHandlers();
  server.handle(harnessStatusRpc, readonly.status);
  server.handle(observabilitySnapshotRpc, readonly.observability);
  server.handle(harnessJobsListRpc, readonly.jobsList);
  server.handle(harnessJobsOutputRpc, readonly.jobsOutput);
  server.handle(harnessSubagentsListRpc, readonly.subagentsList);
  server.handle(harnessSubagentReportRpc, readonly.subagentReport);
  const foregroundTasks = createForegroundTasksHandlers();
  server.handle(foregroundTasksStatusRpc, foregroundTasks.status);
  server.handle(foregroundTasksRpc, foregroundTasks.control);
  const accountControls = createAccountControlsHandlers();
  server.handle(accountControlsStatusRpc, accountControls.status);
  server.handle(accountControlsSwitchRpc, accountControls.switch);
  return () => {};
}
