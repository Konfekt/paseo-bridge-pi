import { useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { Metadata, NativeButton, NativeRow, type PresentationColors } from "./presentation";
import { openGoalForm } from "./goal-form";
import type { z } from "zod";
import type { delegatedGoalEntrySchema, workflowSnapshotSchema } from "../shared/workflows";

/** The parent owns records; only the linked child owns execution. */
export type DelegatedGoal = z.infer<typeof delegatedGoalEntrySchema>;
export type DelegatedGoalRegistry = NonNullable<z.infer<typeof workflowSnapshotSchema>["delegatedGoals"]>;
type Props = {
  registry: DelegatedGoalRegistry;
  colors: PresentationColors;
  identity: string;
  locked: boolean;
  busy: boolean;
  executionAvailable: boolean;
  model: string | null;
  limits: { automaticTurns: number | null; noProgressTurns: number | null };
  post(fields: Record<string, unknown>): Promise<false | { snapshot: { delegatedGoals?: DelegatedGoalRegistry } }>;
};
const statusLabels: Record<DelegatedGoal["status"], string> = {
  paused: "Paused", active: "Working", blocked: "Blocked", usage_limited: "Usage limit reached",
  budget_limited: "Budget reached", complete: "Completed", cleared: "Cleared",
};
const terminal = (goal: DelegatedGoal) => goal.status === "complete" || goal.status === "cleared";
const drafts = new Map<string, ReturnType<typeof openGoalForm>>();
const draftRevisions = new Map<string, number | undefined>();
// Paseo can remount a workspace panel when its compact framing changes. Keep
// UI intent outside that framing, scoped to the exact session/service binding.
const viewStates = new Map<string, Record<string, unknown>>();
function useViewState<T,>(identity: string, name: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const saved = viewStates.get(identity);
    return saved && name in saved ? saved[name] as T : initial;
  });
  return [value, (next: T) => {
    const saved = viewStates.get(identity) ?? {};
    saved[name] = next; viewStates.set(identity, saved); setValue(next);
  }] as const;
}
function GoalForm({ colors, draftKey, goal, locked, onCancel, onSubmit }: {
  colors: PresentationColors; draftKey: string; goal?: DelegatedGoal; locked: boolean;
  onCancel?: () => void; onSubmit(objective: string, tokenBudget: number | undefined, openedRevision?: number): Promise<boolean>;
}) {
  const [openedRevision] = useState(() => {
    if (!draftRevisions.has(draftKey)) draftRevisions.set(draftKey, goal?.revision);
    return draftRevisions.get(draftKey);
  });
  const [form] = useState(() => {
    let model = drafts.get(draftKey);
    if (!model) { model = openGoalForm({ objective: goal?.text, tokenBudget: goal?.tokenBudget }); drafts.set(draftKey, model); }
    return model;
  });
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const stale = !!goal && goal.revision !== openedRevision;
  const input = { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface2,
    color: colors.foreground, paddingHorizontal: 12, paddingVertical: 12, fontSize: 14, lineHeight: 20 } as const;
  function close(notify = true) { form.close(); drafts.delete(draftKey); draftRevisions.delete(draftKey); if (notify) onCancel?.(); }
  return <View style={{ gap: 24, minWidth: 0 }}>
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>{goal ? "Edit goal" : "New goal"}</Text>
      {!goal ? <Metadata colors={colors}>Save an outcome now. Start its child when you’re ready.</Metadata> : null}
    </View>
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>Outcome</Text>
      <TextInput accessibilityLabel={goal ? "Goal objective" : "New goal"} placeholder="What should be achieved?"
        placeholderTextColor={colors.foregroundMuted} value={state.objective} onChangeText={form.setObjective}
        multiline maxLength={4000} editable={!locked} style={[input, { minHeight: 144, textAlignVertical: "top" }]} />
      {state.objectiveError ? <Metadata colors={colors} alert style={{ color: colors.statusDanger }}>{state.objectiveError}</Metadata> : null}
    </View>
    <View style={{ gap: 8, maxWidth: 400 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>Token budget</Text>
      <TextInput accessibilityLabel="Goal token budget" placeholder="Unlimited" placeholderTextColor={colors.foregroundMuted}
        value={state.budget} onChangeText={form.setBudget} keyboardType="numeric" maxLength={7} editable={!locked} style={input} />
      <Metadata colors={colors} alert={!!state.budgetError} style={{ minHeight: 36, color: state.budgetError ? colors.statusDanger : colors.foregroundMuted }}>
        {state.budgetError ?? (goal ? "Applies to this goal’s child only" : "Created paused • No child starts until you choose Start")}
      </Metadata>
    </View>
    {stale ? <Metadata colors={colors} alert style={{ color: colors.statusWarning }}>This goal changed while you were editing. Cancel and reopen it to review the latest version.</Metadata> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <NativeButton colors={colors} primary label={goal ? "Save changes" : "Create"} disabled={locked || stale || !state.canSubmit}
        onPress={() => { if (locked || stale || !state.canSubmit) return; void onSubmit(state.objective.trim(), state.tokenBudget, openedRevision).then(ok => { if (ok) { form.setObjective(""); form.setBudget(""); close(false); } }); }} style={{ minHeight: 44 }} />
      {onCancel ? <NativeButton colors={colors} label="Cancel" onPress={() => close()} disabled={locked} style={{ minHeight: 44, backgroundColor: "transparent" }} /> : null}
    </View>
  </View>;
}

export function DelegatedGoals({ registry, colors, identity, locked, busy, executionAvailable, model, limits, post }: Props) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useViewState<string | null>(identity, "selected", registry.entries.length ? null : "new");
  const [history, setHistory] = useViewState<boolean>(identity, "history", false);
  const [selectionReview, setSelectionReview] = useViewState<boolean>(identity, "selectionReview", false);
  const [editing, setEditing] = useViewState<boolean>(identity, "editing", false);
  const [limitsOpen, setLimitsOpen] = useViewState<boolean>(identity, "limitsOpen", false);
  const [clearConfirm, setClearConfirm] = useViewState<boolean>(identity, "clearConfirm", false);
  const [clearRevision, setClearRevision] = useViewState<number | undefined>(identity, "clearRevision", undefined);
  const [addingTask, setAddingTask] = useViewState<boolean>(identity, "addingTask", false);
  const [taskText, setTaskText] = useViewState<string>(identity, "taskText", "");
  const wide = width >= 760;
  const entries = registry.entries.filter(goal => terminal(goal) === history);
  const selection = selected === null && wide && !selectionReview ? entries[0]?.id ?? (history ? null : "new") : selected;
  const goal = registry.entries.find(entry => entry.id === selection);
  const disabled = locked || busy;
  const budgetExhausted = !!goal && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget;
  const taskDraft = taskText.trim();
  const duplicateTask = !!goal && !!taskDraft && goal.tasks.some(task => task.text.trim() === taskDraft);
  const showDetail = wide || selection !== null;
  const showList = wide || selection === null;
  function select(id: string | null) {
    if (editing && goal) {
      const key = `${identity}/edit/${goal.id}`;
      drafts.get(key)?.close(); drafts.delete(key); draftRevisions.delete(key);
    }
    setSelected(id); setSelectionReview(false); setEditing(false); setLimitsOpen(false); setClearConfirm(false); setAddingTask(false); setTaskText("");
  }
  async function action(name: string, fields: Record<string, unknown> = {}) {
    if (disabled || ((name === "start" || name === "resume") && (!executionAvailable || budgetExhausted))) return false;
    if (name === "add_task" && (!goal || !taskDraft || duplicateTask || goal.status === "active" || terminal(goal))) return false;
    if (goal) setSelected(goal.id);
    return !!(await post({ operation: "start", action: `goals.${name}`, expectedGoalId: goal?.id ?? null,
      expectedEntryRevision: goal?.revision, ...fields }));
  }
  const button = (label: string, onPress: () => void, isDisabled = disabled) => <NativeButton colors={colors} danger={label === "Clear goal"} primary={label === "Start" || label === "Resume"} label={label} onPress={onPress} disabled={isDisabled} style={{ minHeight: 44, alignSelf: "flex-start" }} />;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, minHeight: 480 }}>
    <View style={{ flexDirection: wide ? "row" : "column", minWidth: 0, alignItems: "stretch" }}>
      {showList ? <View style={{ width: wide ? 320 : "100%", flexShrink: 0, padding: 16, gap: 16,
        ...(wide ? { borderRightWidth: 1, borderRightColor: colors.border } : {}) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14, flex: 1 }}>{history ? "Completed goals" : "Goals"}</Text>
          <NativeButton colors={colors} label="New goal" onPress={() => { setHistory(false); select("new"); }} disabled={locked} style={{ minHeight: 44 }} />
        </View>
        {selectionReview ? <Metadata colors={colors}>Goal saved. Select an entry to review.</Metadata> : null}
        <View style={{ gap: 4 }}>
          {entries.length ? entries.map(entry => <NativeRow key={entry.id} colors={colors} title={entry.text}
            detail={`${statusLabels[entry.status]}${entry.tasks.length ? ` · ${entry.tasks.filter(task => task.status === "completed").length}/${entry.tasks.length} tasks` : ""}`}
            selected={selection === entry.id} onPress={() => select(entry.id)}
            leading={<Icon name={entry.status === "complete" ? "CircleCheck" : entry.status === "active" ? "CirclePlay" : "CirclePause"} size={16} color={entry.status === "active" ? colors.foreground : colors.foregroundMuted} />}
            style={{ borderRadius: 8, paddingVertical: 12 }} />) : <View style={{ paddingVertical: 24, gap: 8 }}>
              <Metadata colors={colors}>{history ? "No completed goals" : "No goals yet"}</Metadata>
              {!history ? <Metadata colors={colors}>Each goal has its own child and checklist</Metadata> : null}
            </View>}
        </View>
        <NativeButton colors={colors} label={history ? "Current goals" : "Completed"} onPress={() => { setHistory(!history); select(null); }} style={{ alignSelf: "flex-start", backgroundColor: "transparent", minHeight: 44 }} />
      </View> : null}
      {showDetail ? <View style={{ flex: wide ? 1 : undefined, minWidth: 0, padding: wide ? 32 : 16, gap: 24 }}>
        {!wide ? <View style={{ alignSelf: "flex-start" }}>{button("Back to goals", () => select(null), false)}</View> : null}
        {selection === "new" ? <GoalForm key={`${identity}/create`} draftKey={`${identity}/create`} colors={colors} locked={disabled}
          onCancel={registry.entries.length ? () => select(null) : undefined}
          onSubmit={async (objective, tokenBudget) => {
            const known = new Set(registry.entries.map(entry => entry.id));
            const result = await post({ operation: "start", action: "goals.create", expectedGoalId: null,
              objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) });
            if (result) {
              // Another client may create an entry before the refreshed response.
              // Only auto-select an unambiguous new identity, never the last row
              // or an objective match among several independently-created goals.
              const created = result.snapshot.delegatedGoals?.entries.filter(entry => !known.has(entry.id)) ?? [];
              if (created.length === 1 && created[0].text === objective) select(created[0].id);
              else { select(null); setSelectionReview(true); }
            }
            return !!result;
          }} /> : goal ? editing ? <GoalForm key={`${identity}/edit/${goal.id}`} draftKey={`${identity}/edit/${goal.id}`} colors={colors} goal={goal} locked={disabled}
          onCancel={() => setEditing(false)} onSubmit={async (objective, tokenBudget, openedRevision) => {
            const ok = await action("edit", { objective, expectedEntryRevision: openedRevision, tokenBudget: tokenBudget ?? null });
            if (ok) setEditing(false); return ok;
          }} /> : <>
          <View style={{ gap: 8 }}>
            <Metadata colors={colors}>{goal.waiting ? "Waiting" : statusLabels[goal.status]}{goal.child ? " · Dedicated child" : terminal(goal) ? "" : " · Not started"}</Metadata>
            <Text selectable style={{ color: colors.foreground, fontSize: 16, lineHeight: 24 }}>{goal.text}</Text>
          </View>
          {goal.waiting ? <Metadata colors={colors} style={{ color: colors.statusWarning }}>{goal.waiting}</Metadata> : null}
          {!terminal(goal) ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {goal.status === "active" ? button("Pause", () => { void action("pause"); }, disabled) : button(goal.child ? "Resume" : "Start", () => { void action(goal.child ? "resume" : "start"); }, disabled || !executionAvailable || budgetExhausted)}
            {button("Edit", () => { setSelected(goal.id); setEditing(true); }, disabled || goal.status === "active")}
            {button(limitsOpen ? "Hide limits" : "Limits", () => { setSelected(goal.id); setLimitsOpen(!limitsOpen); }, false)}
            {button("Clear", () => { setSelected(goal.id); setClearRevision(goal.revision); setClearConfirm(true); }, disabled || goal.status === "active")}
          </View> : null}
          {!executionAvailable && !terminal(goal) ? <Metadata colors={colors}>Start and Resume are unavailable in this session</Metadata> : budgetExhausted && goal.status !== "active" && !terminal(goal) ? <Metadata colors={colors}>Raise or remove the token budget before resuming</Metadata> : goal.status === "active" ? <Metadata colors={colors}>Pause the child to edit or clear this goal</Metadata> : null}
          {clearConfirm ? <Modal title="Clear goal?" open onOpenChange={setClearConfirm}><Modal.Content><View style={{ gap: 16 }}>
            <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{goal.text}</Text>
            <Metadata colors={colors}>Its checklist and child history remain in Completed</Metadata>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {button("Keep goal", () => setClearConfirm(false), disabled)}
              {button("Clear goal", () => { void action("clear", { expectedEntryRevision: clearRevision }).then(ok => { if (ok) select(null); }); }, disabled || goal.status === "active" || terminal(goal) || goal.revision !== clearRevision)}
            </View>
          </View></Modal.Content></Modal> : null}
          {limitsOpen ? <View style={{ padding: 16, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
            <Metadata colors={colors}>Automatic responses: {goal.automaticTurns} / {limits.automaticTurns ?? "Unlimited"}</Metadata>
            <Metadata colors={colors}>Tokens: {goal.tokensUsed.toLocaleString()} / {goal.tokenBudget?.toLocaleString() ?? "Unlimited"}</Metadata>
            <Metadata colors={colors}>No-progress limit: {limits.noProgressTurns ?? "Unlimited"}</Metadata>
            <Metadata colors={colors}>Child model: {model ?? "Unavailable"}</Metadata>
          </View> : null}
          <View style={{ gap: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500", flex: 1 }}>Checklist</Text>
              <Metadata colors={colors}>{goal.tasks.filter(task => task.status === "completed").length} / {goal.tasks.length}</Metadata>
            </View>
            {goal.tasks.length ? goal.tasks.map((task, index) => <View key={task.id ?? index} style={{ flexDirection: "row", gap: 12, alignItems: "flex-start", paddingVertical: 4 }}>
              <Icon name={task.status === "completed" ? "CircleCheck" : task.status === "blocked" ? "CircleAlert" : task.status === "in_progress" ? "CirclePlay" : "Circle"} size={16} color={task.status === "blocked" ? colors.statusWarning : colors.foregroundMuted} />
              <Text selectable style={{ flex: 1, color: task.status === "completed" ? colors.foregroundMuted : colors.foreground, fontSize: 14, lineHeight: 20 }}>{task.text}</Text>
            </View>) : <Metadata colors={colors}>{goal.status === "active" ? "No tasks reported yet" : "No tasks yet"}</Metadata>}
            {!terminal(goal) && goal.status !== "active" ? button(addingTask ? "Cancel task" : "Add task", () => { setSelected(goal.id); setAddingTask(!addingTask); setTaskText(""); }, disabled) : null}
            {addingTask ? <View style={{ gap: 8 }}>
              <TextInput accessibilityLabel="Subtask" value={taskText} onChangeText={setTaskText} editable={!disabled && goal.status !== "active" && !terminal(goal)} maxLength={503} placeholder="Describe a task" placeholderTextColor={colors.foregroundMuted}
                style={{ minHeight: 44, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.foreground, backgroundColor: colors.surface2 }} />
              {duplicateTask ? <Metadata colors={colors} alert style={{ color: colors.statusDanger }}>That task is already in this goal</Metadata> : null}
              {button("Save task", () => { void action("add_task", { text: taskDraft }).then(ok => { if (ok) { setAddingTask(false); setTaskText(""); } }); }, disabled || goal.status === "active" || terminal(goal) || !taskDraft || duplicateTask)}
            </View> : null}
          </View>
          {goal.summary ? <View style={{ gap: 8 }}><Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14 }}>Summary</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{goal.summary}</Text></View> : null}
          {goal.child ? <Metadata colors={colors} selectable>Child · {goal.child.taskId}</Metadata> : null}
        </> : <Metadata colors={colors}>{history && !entries.length ? "No completed goals yet" : "Select a goal"}</Metadata>}
      </View> : null}
    </View>
  </View>;
}
