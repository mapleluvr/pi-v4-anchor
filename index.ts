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
  type AnchorPhase,
  type AnchorApi,
  type AnchorState,
} from "./src/core.ts";
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
  description?: string;
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

function statusText(state: AnchorState): string {
  return `v4-anchor:${state.enabled ? state.phase : "off"}`;
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

export default function piV4Anchor(pi: ExtensionAPI): void {
  let state: AnchorState = { enabled: false, phase: "off" };
  let baselineTools: string[] | undefined;
  let baselineSystemPrompt: string | undefined;
  let restoreSystemForNextRequest = false;

  function updateStatus(ctx: AnyContext): void {
    ctx.ui.setStatus(STATUS_KEY, statusText(state));
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

  function restoreTools(piContext: AnyContext): void {
    const tools = baselineTools ?? captureDefaultBaselineTools();
    baselineTools = [...tools];
    pi.setActiveTools(tools);
  }

  function setArmedTools(): void {
    const tools = [...(baselineTools ?? captureCurrentTools())];
    if (!tools.includes("str_replace_editor")) tools.push("str_replace_editor");
    pi.setActiveTools(tools);
  }

  function checkTargetModel(ctx: AnyContext): boolean {
    if (isTargetModel(ctx.model)) return true;
    notify(
      ctx,
      "V4 anchor requires a model id ending in deepseek-v4-pro and an OpenAI Responses, Chat Completions, or Anthropic Messages API; it was not enabled.",
      "warning",
    );
    return false;
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
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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

  async function waitForIdle(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle();
  }

  async function activate(ctx: ExtensionCommandContext): Promise<void> {
    await waitForIdle(ctx);
    if (!checkTargetModel(ctx)) return;
    if (hasConversation(branchEntries(ctx))) {
      notify(ctx, "V4 anchor can only be enabled in a new session before its first message.", "warning");
      return;
    }
    if (state.enabled && state.phase !== "off") {
      notify(ctx, `V4 anchor is already ${state.phase}.`, "info");
      return;
    }
    if (!checkBashAndEditorAvailability(ctx)) return;

    baselineTools = captureCurrentTools();
    baselineSystemPrompt = ctx.getSystemPrompt();
    setArmedTools();
    restoreSystemForNextRequest = false;
    setState({ enabled: true, phase: "bootstrap" }, ctx);
    notify(ctx, "V4 anchor armed for the next request.", "info");
  }

  async function deactivate(ctx: ExtensionCommandContext, announce = true): Promise<void> {
    await waitForIdle(ctx);
    const wasArmed = state.enabled && (state.phase === "bootstrap" || state.phase === "in-flight");
    if (!state.enabled) {
      restoreSystemForNextRequest = false;
      updateStatus(ctx);
      if (announce) notify(ctx, "V4 anchor is already disabled.", "info");
      return;
    }
    if (wasArmed) restoreTools(ctx);
    restoreSystemForNextRequest = false;
    setState({ enabled: false, phase: "off" }, ctx);
    baselineTools = undefined;
    baselineSystemPrompt = undefined;
    if (announce) notify(ctx, "V4 anchor disabled and the previous tool set was restored.", "info");
  }

  function describeStatus(ctx: ExtensionCommandContext): void {
    const target = isTargetModel(ctx.model) ? "target model" : "inactive model";
    notify(ctx, `${statusText(state)} (${target})`, "info");
  }

  function sameTargetModel(left: unknown, right: unknown): boolean {
    if (!isTargetModel(left) || !isTargetModel(right)) return false;
    const leftModel = left as { provider?: unknown; id: string; api: AnchorApi };
    const rightModel = right as { provider?: unknown; id: string; api: AnchorApi };
    return leftModel.provider === rightModel.provider
      && leftModel.id === rightModel.id
      && leftModel.api === rightModel.api;
  }

  function restoreIfModelChanged(
    eventModel: unknown,
    ctx: ExtensionContext,
    previousModel?: unknown,
  ): void {
    if (!state.enabled) return;
    const sameSelectedModel = previousModel === undefined
      ? isTargetModel(eventModel)
      : sameTargetModel(eventModel, previousModel);
    if (sameSelectedModel) return;
    const wasArmed = state.phase === "bootstrap" || state.phase === "in-flight";
    if (wasArmed) restoreTools(ctx);
    restoreSystemForNextRequest = false;
    setState({ enabled: false, phase: "off" }, ctx);
    baselineTools = undefined;
    baselineSystemPrompt = undefined;
    notify(ctx, "V4 anchor disabled because the active model changed.", "warning");
  }

  function promote(ctx: ExtensionContext, restoreOnNextProviderRequest: boolean): void {
    if (!state.enabled || state.phase === "promoted") return;
    restoreTools(ctx);
    restoreSystemForNextRequest = restoreOnNextProviderRequest;
    if (!restoreOnNextProviderRequest) baselineSystemPrompt = undefined;
    setState({ enabled: true, phase: "promoted" }, ctx);
  }

  pi.registerCommand("v4-anchor", {
    description: "Arm, disarm, or inspect the DeepSeek V4 Pro trajectory anchor",
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
    const previousWasArmed = state.enabled && (state.phase === "bootstrap" || state.phase === "in-flight");
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
    restoreSystemForNextRequest = false;

    if (!state.enabled || state.phase === "off") {
      updateStatus(ctx);
      return;
    }

    if (!isTargetModel(ctx.model)) {
      setState({ enabled: false, phase: "off" }, ctx);
      baselineSystemPrompt = undefined;
      notify(ctx, "V4 anchor was disabled because the selected branch does not use the target model.", "warning");
      return;
    }

    if (state.phase === "promoted") {
      baselineSystemPrompt = undefined;
      updateStatus(ctx);
      return;
    }

    if (reason === "fork" || hasConversation(branchEntries(ctx))) {
      setState({ enabled: false, phase: "off" }, ctx);
      baselineSystemPrompt = undefined;
      notify(ctx, "V4 anchor was disabled because this branch is not fresh.", "warning");
      return;
    }

    if (!checkBashAndEditorAvailability(ctx)) {
      setState({ enabled: false, phase: "off" }, ctx);
      baselineSystemPrompt = undefined;
      return;
    }
    setArmedTools();
    updateStatus(ctx);
  }

  pi.on("session_start", (event, ctx) => {
    restoreBranchState(ctx, event.reason);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreBranchState(ctx, "tree");
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!state.enabled || (state.phase !== "bootstrap" && state.phase !== "in-flight")) return;
    restoreTools(ctx);
    restoreSystemForNextRequest = false;
    baselineSystemPrompt = undefined;
    setState({ enabled: false, phase: "off" }, ctx);
    notify(ctx, "V4 anchor was disabled because compaction changed the session trajectory.", "warning");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (state.enabled && (state.phase === "bootstrap" || state.phase === "in-flight")) {
      restoreTools(ctx);
    }
    restoreSystemForNextRequest = false;
    baselineSystemPrompt = undefined;
  });

    pi.on("model_select", (event, ctx) => {
    restoreIfModelChanged(event.model, ctx, event.previousModel);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state.enabled || (state.phase !== "bootstrap" && state.phase !== "in-flight")) return;
    if (!isTargetModel(ctx.model)) return;
    if (event.systemPrompt && event.systemPrompt !== MINIMAL_PERSONA) {
      baselineSystemPrompt = event.systemPrompt;
    }
    return { systemPrompt: MINIMAL_PERSONA };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!state.enabled) return;
    const model = ctx.model;
    if (!model || !isTargetModel(model)) {
      restoreIfModelChanged(model, ctx);
      return;
    }
    if ((state.phase === "bootstrap" || state.phase === "in-flight") && !checkBashAndEditorAvailability(ctx)) {
      restoreTools(ctx);
      restoreSystemForNextRequest = false;
      setState({ enabled: false, phase: "off" }, ctx);
      baselineTools = undefined;
      baselineSystemPrompt = undefined;
      return;
    }

    if (state.phase === "bootstrap" || state.phase === "in-flight") {
      try {
        const api = apiForModel(model);
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
        const systemPrompt = baselineSystemPrompt ?? ctx.getSystemPrompt();
        restoreTools(ctx);
        restoreSystemForNextRequest = false;
        setState({ enabled: false, phase: "off" }, ctx);
        baselineTools = undefined;
        baselineSystemPrompt = undefined;
        const reason = error instanceof Error ? error.message : String(error);
        notify(ctx, `V4 anchor payload validation failed and was disabled: ${reason}`, "error");
        try {
          return restoreSystemPrompt(event.payload, systemPrompt, apiForModel(model));
        } catch {
          return event.payload;
        }
      }
    }

    if (state.phase === "promoted" && restoreSystemForNextRequest) {
      restoreSystemForNextRequest = false;
      return restoreSystemPrompt(
        event.payload,
        baselineSystemPrompt ?? ctx.getSystemPrompt(),
        apiForModel(model),
      );
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
    promote(ctx, false);
  });

  pi.on("tool_result", (_event, ctx) => {
    if (!state.enabled || state.phase !== "in-flight") return;
    promote(ctx, true);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (state.enabled && state.phase === "in-flight") {
      setState({ enabled: true, phase: "bootstrap" }, ctx);
    }
    if (restoreSystemForNextRequest) {
      restoreSystemForNextRequest = false;
      baselineSystemPrompt = undefined;
    }
  });
}

export { EDITOR_DESCRIPTION, MINIMAL_BASH_DESCRIPTION, MINIMAL_PERSONA };
