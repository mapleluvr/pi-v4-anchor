import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ANCHOR_STATE_ENTRY,
  captureContinuationSystemPrompt,
  hasConversation,
  isTargetModel,
  MINIMAL_BASH_DESCRIPTION,
  MINIMAL_PERSONA,
  readAnchorSnapshot,
  restoreSystemPrompt,
  rewriteBootstrapPayload,
  rewritePersistentPayload,
  type AnchorApi,
  type AnchorState,
} from "./src/core.ts";
import { FileAnchorIntentStore, type AnchorIntentStore } from "./src/intent.ts";
import { EDITOR_DESCRIPTION, executeEditor } from "./src/editor.ts";

const STATUS_KEY = "v4-anchor";
const EDITOR_MAX_OUTPUT_CHARS = 16_000;
const EXTENSION_PATH = resolve(fileURLToPath(import.meta.url));

const EDITOR_PARAMETERS = Type.Object({
  command: Type.Union([
    Type.Literal("view"),
    Type.Literal("create"),
    Type.Literal("str_replace"),
    Type.Literal("insert"),
  ]),
  path: Type.String({
    description: "Absolute path; on Windows use C:/..., C:\\\\..., /c/..., or /mnt/c/...",
  }),
  file_text: Type.Optional(Type.String({ description: "Text for the create command" })),
  insert_line: Type.Optional(Type.Integer({ description: "Zero-based insertion line" })),
  new_str: Type.Optional(Type.String({ description: "Replacement or insertion text" })),
  old_str: Type.Optional(Type.String({ description: "Exact text to replace" })),
  view_range: Type.Optional(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
});

type EditorParameters = Static<typeof EDITOR_PARAMETERS>;
type AnyContext = ExtensionContext | ExtensionCommandContext;

type ToolInfoLike = {
  name?: string;
  sourceInfo?: {
    path?: string;
    source?: string;
  };
};

type AssistantLike = {
  role?: string;
  content?: unknown;
  stopReason?: string;
};

export interface PiV4AnchorOptions {
  intentStore?: AnchorIntentStore;
}

function statusText(state: AnchorState, desiredEnabled: boolean, model: unknown): string {
  if (!desiredEnabled) return "v4-anchor:off";
  if (!isTargetModel(model) || !state.enabled || state.phase === "off") {
    return "v4-anchor:standby";
  }
  return state.phase === "promoted"
    ? "v4-anchor:promoted:persistent"
    : `v4-anchor:${state.phase}`;
}

function notify(ctx: AnyContext, message: string, level: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, level);
}

function hasToolCall(message: AssistantLike): boolean {
  if (message.stopReason === "toolUse" || message.stopReason === "tool_use") return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const type = (block as { type?: unknown }).type;
    return type === "toolCall" || type === "tool_use" || type === "function_call";
  });
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isBuiltinTool(info: ToolInfoLike | undefined): boolean {
  return info?.sourceInfo?.source === "builtin";
}

function apiForModel(model: { api?: unknown } | undefined): AnchorApi | undefined {
  return model?.api === "openai-responses"
    || model?.api === "openai-completions"
    || model?.api === "anthropic-messages"
    ? model.api
    : undefined;
}

function branchEntries(ctx: AnyContext): readonly unknown[] {
  return ctx.sessionManager.getBranch();
}

export default function piV4Anchor(pi: ExtensionAPI, options: PiV4AnchorOptions = {}): void {
  const intentStore = options.intentStore ?? new FileAnchorIntentStore();
  let desiredEnabled = intentStore.read();
  let state: AnchorState = { enabled: false, phase: "off" };
  let baselineTools: string[] | undefined;
  let baselineSystemPrompt: string | undefined;

  function updateStatus(ctx: AnyContext, model: unknown = ctx.model): void {
    ctx.ui.setStatus(STATUS_KEY, statusText(state, desiredEnabled, model));
  }

  function persistState(ctx: AnyContext): void {
    const data = state.enabled && baselineTools !== undefined
      ? { ...state, baselineTools: [...baselineTools] }
      : { ...state };
    pi.appendEntry(ANCHOR_STATE_ENTRY, data);
    updateStatus(ctx);
  }

  function setState(next: AnchorState, ctx: AnyContext, persist = true): void {
    state = next.enabled ? { ...next } : { enabled: false, phase: "off" };
    if (persist) persistState(ctx);
    else updateStatus(ctx);
  }

  function refreshDesiredIntent(): boolean {
    try {
      desiredEnabled = intentStore.read();
    } catch {
      desiredEnabled = false;
    }
    return desiredEnabled;
  }

  function writeDesiredIntent(enabled: boolean, ctx: AnyContext): boolean {
    try {
      intentStore.write(enabled);
      desiredEnabled = enabled;
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notify(ctx, `V4 anchor could not update its shared enablement state: ${reason}`, "error");
      return false;
    }
  }

  function ownsEditorDefinition(): boolean {
    const editor = (pi.getAllTools() as ToolInfoLike[]).find((tool) => tool.name === "str_replace_editor");
    const sourcePath = editor?.sourceInfo?.path;
    return typeof sourcePath === "string" && sameFilesystemPath(sourcePath, EXTENSION_PATH);
  }

  function captureCurrentTools(): string[] {
    return pi.getActiveTools();
  }

  function captureDefaultBaselineTools(): string[] {
    const removeAnchorEditor = ownsEditorDefinition();
    return captureCurrentTools().filter((name) => name !== "str_replace_editor" || !removeAnchorEditor);
  }

  function restoreTools(ctx: AnyContext): void {
    const tools = baselineTools ?? captureDefaultBaselineTools();
    baselineTools = [...tools];
    pi.setActiveTools(tools);
  }

  function setArmedTools(): void {
    const tools = [...(baselineTools ?? captureCurrentTools())];
    if (!tools.includes("str_replace_editor")) tools.push("str_replace_editor");
    pi.setActiveTools(tools);
  }

  function isArmed(): boolean {
    return state.enabled && (state.phase === "bootstrap" || state.phase === "in-flight");
  }

  function checkBashAndEditorAvailability(ctx: AnyContext): boolean {
    if (!pi.getActiveTools().includes("bash")) {
      notify(ctx, "V4 anchor requires Pi's built-in bash to be active in the current tool set.", "error");
      return false;
    }
    const tools = pi.getAllTools() as ToolInfoLike[];
    const bash = tools.find((tool) => tool.name === "bash");
    if (!bash) {
      notify(ctx, "V4 anchor requires Pi's built-in bash tool, but bash is unavailable.", "error");
      return false;
    }
    if (!isBuiltinTool(bash)) {
      notify(ctx, "V4 anchor requires Pi's built-in bash; another extension already overrides bash.", "error");
      return false;
    }

    const existingEditor = tools.find((tool) => tool.name === "str_replace_editor");
    if (!existingEditor) {
      notify(ctx, "V4 anchor's str_replace_editor is unavailable; check Pi's tool allowlist.", "error");
      return false;
    }
    if (!ownsEditorDefinition()) {
      notify(ctx, "V4 anchor cannot use str_replace_editor because another tool owns that name.", "error");
      return false;
    }
    return true;
  }

  function registerEditorTool(): void {
    pi.registerTool({
      name: "str_replace_editor",
      label: "str_replace_editor",
      description: EDITOR_DESCRIPTION,
      parameters: EDITOR_PARAMETERS,
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        const result = await executeEditor(params as EditorParameters, {
          maxOutputChars: EDITOR_MAX_OUTPUT_CHARS,
          signal,
          withMutationQueue: (path, operation) => withFileMutationQueue(path, operation),
        });
        return {
          content: [{ type: "text", text: result }],
          details: { path: params.path, command: params.command },
        };
      },
    });
  }

  registerEditorTool();

  function clearLocalState(ctx: AnyContext, persist = true): void {
    const wasEnabled = state.enabled;
    if (isArmed()) restoreTools(ctx);
    baselineSystemPrompt = undefined;
    baselineTools = undefined;
    if (wasEnabled) setState({ enabled: false, phase: "off" }, ctx, persist);
    else updateStatus(ctx);
  }

  function armFreshTarget(ctx: AnyContext, model: unknown, persist = true): boolean {
    if (!desiredEnabled || !isTargetModel(model)) return false;
    if (state.enabled && state.phase !== "off") {
      if (isArmed()) setArmedTools();
      updateStatus(ctx, model);
      return true;
    }
    if (hasConversation(branchEntries(ctx))) {
      updateStatus(ctx, model);
      return false;
    }
    if (!checkBashAndEditorAvailability(ctx)) {
      updateStatus(ctx, model);
      return false;
    }

    baselineTools = captureCurrentTools();
    baselineSystemPrompt = ctx.getSystemPrompt();
    setArmedTools();
    setState({ enabled: true, phase: "bootstrap" }, ctx, persist);
    return true;
  }

  function reconcileForModel(ctx: AnyContext, model: unknown = ctx.model, allowFreshArm = true): void {
    refreshDesiredIntent();
    if (!desiredEnabled) {
      clearLocalState(ctx);
      return;
    }

    if (!isTargetModel(model)) {
      if (isArmed()) clearLocalState(ctx);
      updateStatus(ctx, model);
      return;
    }

    if (state.enabled && state.phase === "promoted") {
      updateStatus(ctx, model);
      return;
    }
    if (isArmed()) {
      setArmedTools();
      updateStatus(ctx, model);
      return;
    }
    if (allowFreshArm) armFreshTarget(ctx, model);
    else updateStatus(ctx, model);
  }

  async function waitForIdle(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle();
  }

  async function activate(ctx: ExtensionCommandContext): Promise<void> {
    await waitForIdle(ctx);
    if (!writeDesiredIntent(true, ctx)) return;

    if (!isTargetModel(ctx.model)) {
      updateStatus(ctx);
      notify(ctx, "V4 anchor is enabled for every Pi instance; this model is on standby until its id ends in deepseek-v4-pro.", "info");
      return;
    }
    if (state.enabled && state.phase !== "off") {
      reconcileForModel(ctx);
      notify(ctx, `V4 anchor is already ${state.phase}.`, "info");
      return;
    }
    if (!armFreshTarget(ctx, ctx.model)) {
      if (hasConversation(branchEntries(ctx))) {
        notify(ctx, "V4 anchor is enabled globally and will arm fresh target-model sessions.", "info");
      }
      return;
    }
    notify(ctx, "V4 anchor is enabled globally and armed for the next request.", "info");
  }

  async function deactivate(ctx: ExtensionCommandContext, announce = true): Promise<void> {
    await waitForIdle(ctx);
    const wasDesired = desiredEnabled;
    if (!writeDesiredIntent(false, ctx)) return;
    const wasEnabled = state.enabled;
    clearLocalState(ctx);
    if (announce) {
      notify(
        ctx,
        wasDesired || wasEnabled
          ? "V4 anchor was disabled for this and future Pi instances."
          : "V4 anchor is already disabled.",
        "info",
      );
    }
  }

  function describeStatus(ctx: ExtensionCommandContext): void {
    refreshDesiredIntent();
    const target = isTargetModel(ctx.model) ? "target model" : "inactive model";
    const intent = desiredEnabled ? "global enablement on" : "global enablement off";
    notify(ctx, `${statusText(state, desiredEnabled, ctx.model)} (${target}; ${intent})`, "info");
  }

  function promote(ctx: ExtensionContext): void {
    if (!state.enabled || state.phase === "promoted") return;
    restoreTools(ctx);
    setState({ enabled: true, phase: "promoted" }, ctx);
  }

  function disableForPayloadFailure(ctx: ExtensionContext, reason: string, payload: unknown, api: AnchorApi | undefined): unknown {
    const systemPrompt = baselineSystemPrompt ?? ctx.getSystemPrompt();
    clearLocalState(ctx);
    notify(ctx, `V4 anchor payload validation failed for this branch: ${reason}`, "error");
    try {
      return restoreSystemPrompt(payload, systemPrompt, api);
    } catch {
      return payload;
    }
  }

  pi.registerCommand("v4-anchor", {
    description: "Globally enable, disable, or inspect the DeepSeek V4 Pro trajectory anchor",
    getArgumentCompletions: (argumentPrefix) => {
      const values = ["on", "off", "status"];
      return values
        .filter((value) => value.startsWith(argumentPrefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "on") {
        await activate(ctx);
      } else if (command === "off") {
        await deactivate(ctx);
      } else if (command === "status") {
        describeStatus(ctx);
      } else {
        notify(ctx, "Usage: /v4-anchor on|off|status", "warning");
      }
    },
  });

  function restoreBranchState(
    ctx: ExtensionContext,
    reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree",
  ): void {
    const previousWasArmed = isArmed();
    const previousBaseline = baselineTools;
    const snapshot = readAnchorSnapshot(branchEntries(ctx));
    state = snapshot.state;
    const fallbackTools = reason === "startup"
      ? captureDefaultBaselineTools()
      : captureCurrentTools();
    baselineTools = snapshot.baselineTools === undefined
      ? reason === "tree" && previousWasArmed && previousBaseline !== undefined
        ? [...previousBaseline]
        : [...fallbackTools]
      : [...snapshot.baselineTools];
    restoreTools(ctx);
    baselineSystemPrompt = ctx.getSystemPrompt();
    refreshDesiredIntent();

    if (!desiredEnabled) {
      if (state.enabled) clearLocalState(ctx);
      else updateStatus(ctx);
      return;
    }

    if (state.enabled && state.phase === "promoted") {
      updateStatus(ctx);
      return;
    }

    if (!isTargetModel(ctx.model)) {
      if (isArmed()) restoreTools(ctx);
      updateStatus(ctx);
      return;
    }

    if (isArmed()) {
      if (reason === "fork" || hasConversation(branchEntries(ctx))) {
        clearLocalState(ctx);
        notify(ctx, "V4 anchor was closed for this branch because it is not fresh.", "warning");
        return;
      }
      if (!checkBashAndEditorAvailability(ctx)) {
        clearLocalState(ctx);
        return;
      }
      setArmedTools();
      updateStatus(ctx);
      return;
    }

    if (reason !== "fork") armFreshTarget(ctx, ctx.model);
    else updateStatus(ctx);
  }

  pi.on("session_start", (event, ctx) => {
    restoreBranchState(ctx, event.reason);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreBranchState(ctx, "tree");
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!isArmed()) return;
    clearLocalState(ctx);
    notify(ctx, "V4 anchor was closed for this branch because compaction changed the session trajectory.", "warning");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (isArmed()) restoreTools(ctx);
    baselineSystemPrompt = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    reconcileForModel(ctx, event.model);
  });

  pi.on("before_agent_start", (event, ctx) => {
    reconcileForModel(ctx);
    if (!desiredEnabled || !state.enabled || !isTargetModel(ctx.model)) return;
    if (event.systemPrompt && event.systemPrompt !== MINIMAL_PERSONA) {
      baselineSystemPrompt = event.systemPrompt;
    }
    return { systemPrompt: MINIMAL_PERSONA };
  });

  pi.on("before_provider_request", (event, ctx) => {
    refreshDesiredIntent();
    const model = ctx.model;
    if (!desiredEnabled) {
      clearLocalState(ctx);
      return;
    }
    if (!model || !isTargetModel(model)) {
      if (isArmed()) clearLocalState(ctx);
      else updateStatus(ctx, model);
      return;
    }

    if (!state.enabled) {
      armFreshTarget(ctx, model);
      if (!state.enabled) return;
    }

    const api = apiForModel(model);
    if (isArmed()) {
      if (!checkBashAndEditorAvailability(ctx)) {
        clearLocalState(ctx);
        return;
      }
      try {
        baselineSystemPrompt = captureContinuationSystemPrompt(
          event.payload,
          baselineSystemPrompt ?? ctx.getSystemPrompt(),
          api,
        );
        const rewritten = rewriteBootstrapPayload(event.payload, {
          api,
          modelId: typeof model.id === "string" ? model.id : undefined,
          maxOutputTokens: undefined,
        });
        if (state.phase === "bootstrap") {
          setState({ enabled: true, phase: "in-flight" }, ctx);
        }
        return rewritten;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return disableForPayloadFailure(ctx, reason, event.payload, api);
      }
    }

    if (state.phase === "promoted") {
      try {
        baselineSystemPrompt = captureContinuationSystemPrompt(
          event.payload,
          baselineSystemPrompt ?? ctx.getSystemPrompt(),
          api,
        );
        return rewritePersistentPayload(event.payload, {
          api,
          context: baselineSystemPrompt,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return disableForPayloadFailure(ctx, reason, event.payload, api);
      }
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!state.enabled || state.phase !== "in-flight" || event.status < 400) return;
    setState({ enabled: true, phase: "bootstrap" }, ctx);
    notify(ctx, "V4 anchor bootstrap failed; it remains armed for a retry.", "warning");
  });

  pi.on("message_end", (event, ctx) => {
    if (!state.enabled || state.phase !== "in-flight") return;
    const message = event.message as AssistantLike;
    if (message.role !== "assistant") return;
    if (hasToolCall(message)) return;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      setState({ enabled: true, phase: "bootstrap" }, ctx);
      return;
    }
    promote(ctx);
  });

  pi.on("tool_result", (_event, ctx) => {
    if (!state.enabled || state.phase !== "in-flight") return;
    promote(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (state.enabled && state.phase === "in-flight") {
      setState({ enabled: true, phase: "bootstrap" }, ctx);
    }
  });
}

export { EDITOR_DESCRIPTION, MINIMAL_BASH_DESCRIPTION, MINIMAL_PERSONA };
