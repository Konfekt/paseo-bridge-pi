// Explicit dormant-module coverage, not the shipped plugin contribution.
import { contributeObservability } from "./client/observability";
import { contributeAccountControls } from "./client/account-controls";
import type { PluginClientContext } from "@getpaseo/plugin/client";
export default function contribute(client: PluginClientContext) {
  const stopActivity = contributeObservability(client);
  const stopAccounts = contributeAccountControls(client);
  return () => { stopAccounts(); stopActivity(); };
}
