/** Layout/transport adapter over the unchanged native Pi mapper and public
 * protocol display policy. The compiler bundles these pure implementations;
 * no native app component, private context or new host SDK import is used. */
import { mapPiToolCallDetail, parseToolArgs, parseToolResult, nativeToolErrorText } from "@getpaseo/server/pi-tool-presentation";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { buildGenericToolSections } from "@getpaseo/protocol/generic-tool-presentation";
import { buildPaseoToolDetailSections } from "@getpaseo/protocol/paseo-tool-presentation/index";
import type { PaseoToolDetailSection } from "@getpaseo/protocol/paseo-tool-presentation/index";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { toolDetailTextBudget, toolPresentationValue } from "./native-tool-details";
import { validateToolPresentation } from "../shared/tool-presentation";
import type { TranscriptToolStatus } from "../shared/transcript-tools";

export type NativeCodeSection = { kind: "code"; label: string; text: string; tone?: "removed" | "added"; filePath?: string; startLine?: number; unifiedDiff?: boolean; error?: boolean };
export type NativeToolSection = PaseoToolDetailSection | NativeCodeSection;
export type NativeToolStatus = TranscriptToolStatus;
const DETAIL_ICONS: Record<ToolCallDetail["type"],string> = {shell:"SquareTerminal",read:"Eye",edit:"Pencil",write:"Pencil",search:"Search",fetch:"Search",sub_agent:"Bot",plain_text:"Wrench",unknown:"Wrench",plan:"ListTodo",worktree_setup:"GitBranch"};

/** No tool-name switch: classification, argument validation, literal/result
 * handling, custom-tool projection and badge labels all belong to native code. */
export function nativeToolModel(name: string, input: unknown, output: unknown, status: NativeToolStatus = "completed", toolPresentation?: unknown, resultSource: "live" | "history" = "live", callId = "") {
  const safeInput = toolPresentationValue(input);
  const presented = validateToolPresentation(toolPresentation);
  // The optional field restores known typed producer data lost by text clipping.
  // It is never parsed from prose and cannot change tool identity or navigation.
  const typed = presented?.toolName === name;
  const safeOutput = typed ? presented.result : toolPresentationValue(output, true);
  // Match the actual native caller, not just the mapper: retained history
  // reconstructs content/details and keeps lifecycle isError outside result.
  const historyPayload = safeOutput && typeof safeOutput === "object" && !Array.isArray(safeOutput) ? safeOutput as Record<string, unknown> : undefined;
  const content = historyPayload?.content;
  const nativeHistory = resultSource === "history" && (typed || (Array.isArray(content) && content.length > 0));
  const parsedResult = parseToolResult(nativeHistory ? { content, details: historyPayload?.details } : safeOutput);
  // The native parser's schema table is a normal object. Reserved prototype
  // names are unclassified input, never executable/schema properties.
  const tracked = Object.prototype.hasOwnProperty.call(Object.prototype, name)
    ? { kind: "unknown" as const, toolName: name, args: safeInput ?? null }
    : parseToolArgs(name, safeInput);
  const detail = mapPiToolCallDetail(tracked, parsedResult, callId);
  const display = buildToolCallDisplayModel({
    name, detail, status: status === "unknown" ? "running" : status === "cancelled" ? "canceled" : status,
    error: status === "failed" ? nativeToolErrorText(nativeHistory ? parsedResult : safeOutput, name) : null,
  });
  return { detail, display, icon: DETAIL_ICONS[detail.type], sections: sectionsForDetail(name, detail, display.errorText) };
}

/** Render projections of the native detail union; these are layout decisions,
 * not a second tool parser/catalog. Code/diff highlighting stays canonical too. */
function sectionsForDetail(name: string, detail: ToolCallDetail, errorText?: string): NativeToolSection[] {
  const sections: NativeToolSection[] = [];
  const prose = (text: string | undefined, title = "") => { if (typeof text === "string" && text) sections.push({kind:"prose",title,text}); };
  const code = (text: string | undefined, label = "", options: Partial<NativeCodeSection> = {}) => { if (typeof text === "string" && text) sections.push({kind:"code",label,text,...options}); };
  switch (detail.type) {
    case "shell": code(detail.command, "Command"); code(detail.output, "Output"); break;
    case "read": code(detail.content, "", {filePath:detail.filePath,startLine:detail.offset ?? 1}); break;
    case "write": code(detail.content, "", {filePath:detail.filePath}); break;
    case "edit":
      if (typeof detail.unifiedDiff === "string" && detail.unifiedDiff) code(detail.unifiedDiff, "", {filePath:detail.filePath,unifiedDiff:true});
      else {
        code(detail.oldString, "Removed", {filePath:detail.filePath,tone:"removed"});
        code(detail.newString, "Added", {filePath:detail.filePath,tone:"added"});
      }
      break;
    case "search":
      code(detail.content);
      if (detail.filePaths?.length) code(detail.filePaths.join("\n"));
      if (detail.webResults?.length) code(detail.webResults.map(value => `${value.title}\n${value.url}`).join("\n\n"));
      if (detail.annotations?.length) code(detail.annotations.join("\n\n"));
      break;
    case "fetch": code(detail.result ? `${detail.url}\n\n${detail.result}` : detail.url); break;
    case "sub_agent": prose(detail.log); break;
    case "plain_text": prose(detail.text); break;
    case "unknown": sections.push(...(buildPaseoToolDetailSections(name,detail.input,detail.output) ?? buildGenericToolSections(name,detail.input,detail.output))); break;
    // Pi's mapper does not currently emit these protocol variants. Preserve
    // their meaningful text if a future native mapper does, never drop output.
    case "plan": prose(detail.text); break;
    case "worktree_setup": prose(detail.log); break;
    default: { const exhaustive: never = detail; throw new Error(`Unsupported native detail: ${String(exhaustive)}`); }
  }
  code(errorText, "Error", { error: true });
  const text = toolDetailTextBudget();
  return sections.slice(0,128).map(section => section.kind === "fields"
    ? {...section,title:text(section.title),fields:section.fields.slice(0,128).map(field => ({label:text(field.label),value:text(field.value)}))}
    : section.kind === "code" ? {...section,label:text(section.label),text:text(section.text)}
      : {...section,title:text(section.title),text:text(section.text)});
}

export function nativeToolSections(name: string, input: unknown, output: unknown, failed = false): NativeToolSection[] {
  return nativeToolModel(name,input,output,failed ? "failed" : "completed").sections;
}
export function nativeToolPresentation(name: string, input: unknown, output?: unknown, status: NativeToolStatus = "completed") {
  const {display,icon} = nativeToolModel(name,input,output,status);
  return {label:display.displayName,summary:display.summary,icon};
}
