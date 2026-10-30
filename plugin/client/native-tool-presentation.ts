/** Plain tool details using only plugin-owned transport validation. */
import { normalizeToolResult, toolDetailTextBudget, toolPresentationValue } from "./native-tool-details";
import { extractToolPresentationArguments, validateToolPresentation } from "../shared/tool-presentation";

export type NativeToolSection = { label: string; text: string; error?: boolean };

export function nativeToolSections(name: string, input: unknown, output: unknown, failed = false, toolPresentation?: unknown): NativeToolSection[] {
  const presented = validateToolPresentation(toolPresentation);
  const safeOutput = presented?.toolName === name ? presented.result : output;
  const projectedInput = extractToolPresentationArguments(name, input);
  // An empty projection identifies an existing allowlist without copying its
  // tool catalog. Invalid known-tool arguments must not bypass that allowlist.
  const hasArgumentSchema = extractToolPresentationArguments(name, {}) !== undefined;
  const safeInput = toolPresentationValue(projectedInput ?? (hasArgumentSchema && input !== undefined ? "[tool arguments unavailable]" : input));
  const text = toolDetailTextBudget();
  // Reserve result space first so large arguments cannot hide failure details.
  const resultLabel = text(failed ? "Error" : "Output");
  const resultText = text(normalizeToolResult(toolPresentationValue(safeOutput, true)));
  const inputLabel = text("Arguments");
  const inputText = text(typeof safeInput === "string" ? safeInput : JSON.stringify(safeInput, null, 2) ?? "");
  const sections: NativeToolSection[] = [];
  if (inputText) sections.push({ label: inputLabel, text: inputText });
  if (resultText) sections.push({ label: resultLabel, text: resultText, error: failed });
  return sections;
}
