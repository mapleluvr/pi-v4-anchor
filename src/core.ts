import { posix, win32 } from "node:path";

export const MINIMAL_PERSONA = "You are a helpful software engineer assistant.";

export const MINIMAL_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

export const MINIMAL_BASH_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The bash command to run.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const BOOTSTRAP_TOOL_NAMES = ["bash", "str_replace_editor"] as const;
const TARGET_MODEL_SUFFIX = "deepseek-v4-pro";

export type AnchorApi = "openai-responses" | "openai-completions" | "anthropic-messages";
export type SupportedPlatform = "win32" | "posix";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnchorApi(value: unknown): value is AnchorApi {
  return value === "openai-responses"
    || value === "openai-completions"
    || value === "anthropic-messages";
}

function detectPayloadApi(payload: JsonRecord): AnchorApi | undefined {
  if (Array.isArray(payload.input)) return "openai-responses";
  if (!Array.isArray(payload.messages)) return undefined;
  if ("system" in payload) return "anthropic-messages";
  if (Array.isArray(payload.tools) && payload.tools.some((tool) =>
    isRecord(tool) && typeof tool.name === "string" && "input_schema" in tool,
  )) {
    return "anthropic-messages";
  }
  return "openai-completions";
}

function stripToolPathPrefix(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function normalizeEditorPath(
  input: string,
  platform: SupportedPlatform = process.platform === "win32" ? "win32" : "posix",
): string {
  const candidate = stripToolPathPrefix(input);
  if (!candidate) throw new Error("Path must not be empty");

  if (platform === "posix") {
    if (!posix.isAbsolute(candidate)) {
      throw new Error("Path must be absolute");
    }
    return posix.normalize(candidate);
  }

  const wsl = candidate.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (wsl) {
    const [, drive, tail = ""] = wsl;
    return win32.normalize(`${drive.toUpperCase()}:\\${tail.replaceAll("/", "\\")}`);
  }

  const msys = candidate.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (msys) {
    const [, drive, tail = ""] = msys;
    return win32.normalize(`${drive.toUpperCase()}:\\${tail.replaceAll("/", "\\")}`);
  }

  if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\")) {
    const normalized = win32.normalize(candidate);
    return normalized.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
  }

  if (candidate.startsWith("/")) {
    throw new Error(
      "Path must be a drive-qualified Windows path (C:/...), an MSYS path (/c/...), or a WSL path (/mnt/c/...)",
    );
  }

  throw new Error("Path must be absolute");
}

function serializedToolName(tool: JsonRecord): string | undefined {
  if (typeof tool.name === "string") return tool.name;
  return isRecord(tool.function) && typeof tool.function.name === "string"
    ? tool.function.name
    : undefined;
}

function rewriteBashTool(tool: JsonRecord, api: AnchorApi): JsonRecord {
  if (api === "anthropic-messages") {
    const rewritten: JsonRecord = {
      ...tool,
      description: MINIMAL_BASH_DESCRIPTION,
      input_schema: MINIMAL_BASH_PARAMETERS,
    };
    delete rewritten.parameters;
    return rewritten;
  }

  if (typeof tool.name === "string") {
    return {
      ...tool,
      description: MINIMAL_BASH_DESCRIPTION,
      parameters: MINIMAL_BASH_PARAMETERS,
    };
  }

  if (isRecord(tool.function)) {
    return {
      ...tool,
      function: {
        ...tool.function,
        description: MINIMAL_BASH_DESCRIPTION,
        parameters: MINIMAL_BASH_PARAMETERS,
      },
    };
  }

  return tool;
}

function validateBootstrapItems(items: readonly unknown[], api: AnchorApi): void {
  let hasUser = false;
  for (const item of items) {
    if (!isRecord(item)) throw new Error("unsupported non-object bootstrap input item");
    if (api !== "anthropic-messages" && (item.role === "system" || item.role === "developer")) continue;
    if (item.role === "user") {
      hasUser = true;
      continue;
    }
    const role = typeof item.role === "string"
      ? item.role
      : typeof item.type === "string"
        ? item.type
        : "unknown";
    throw new Error(`unsupported bootstrap role: ${role}`);
  }
  if (!hasUser) throw new Error("Provider payload is missing the bootstrap user message");
}

function rewriteSystemItems(
  items: unknown[],
  systemPrompt = MINIMAL_PERSONA,
  dropAdditionalSystemItems = true,
): unknown[] {
  const rewritten: unknown[] = [];
  let foundSystem = false;

  for (const item of items) {
    if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) {
      rewritten.push(item);
      continue;
    }

    if (foundSystem) {
      if (!dropAdditionalSystemItems) rewritten.push(item);
      continue;
    }
    rewritten.push({ ...item, content: systemPrompt });
    foundSystem = true;
  }

  if (!foundSystem) {
    rewritten.unshift({ role: "system", content: systemPrompt });
  }

  return rewritten;
}

function rewriteAnthropicSystem(value: unknown, systemPrompt: string): unknown {
  if (!Array.isArray(value)) return systemPrompt;
  const first = isRecord(value[0]) ? value[0] : { type: "text" };
  return [{ ...first, type: "text", text: systemPrompt }];
}

function restoreAnthropicSystem(value: unknown, systemPrompt: string): unknown {
  if (!Array.isArray(value)) return systemPrompt;
  if (value.length === 0) return [{ type: "text", text: systemPrompt }];
  return value.map((item, index) => {
    if (index !== 0 || !isRecord(item)) return item;
    return { ...item, type: "text", text: systemPrompt };
  });
}

function serializedSystemText(payload: JsonRecord, api: AnchorApi): string | undefined {
  const value = api === "anthropic-messages"
    ? payload.system
    : (() => {
      const items = Array.isArray(payload.input) ? payload.input : payload.messages;
      if (!Array.isArray(items)) return payload.instructions;
      const systemItem = items.find((item) => (
        isRecord(item) && (item.role === "system" || item.role === "developer")
      ));
      return isRecord(systemItem) ? systemItem.content : payload.instructions;
    })();

  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const textPart = value.find((part) => isRecord(part) && typeof part.text === "string");
  return isRecord(textPart) && typeof textPart.text === "string" ? textPart.text : undefined;
}

export function captureContinuationSystemPrompt(
  payload: unknown,
  baselineSystemPrompt: string,
  api?: AnchorApi,
): string {
  if (!isRecord(payload)) throw new Error("Provider payload must be an object");
  if (!baselineSystemPrompt) throw new Error("baselineSystemPrompt must be a non-empty string");
  const resolvedApi = api ?? detectPayloadApi(payload);
  if (!resolvedApi) return baselineSystemPrompt;
  const observed = serializedSystemText(payload, resolvedApi);
  if (!observed || observed === MINIMAL_PERSONA) return baselineSystemPrompt;
  if (observed.startsWith(MINIMAL_PERSONA)) {
    return `${baselineSystemPrompt}${observed.slice(MINIMAL_PERSONA.length)}`;
  }
  return observed;
}

export interface BootstrapPayloadOptions {
  api?: AnchorApi;
  modelId?: string;
  maxOutputTokens?: number;
}

export function restoreSystemPrompt(
  payload: unknown,
  systemPrompt: string,
  api?: AnchorApi,
): unknown {
  if (!isRecord(payload)) throw new Error("Provider payload must be an object");
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0) {
    throw new Error("systemPrompt must be a non-empty string");
  }
  const resolvedApi = api ?? detectPayloadApi(payload);
  if (resolvedApi === "anthropic-messages") {
    const restored: JsonRecord = { ...payload };
    restored.system = restoreAnthropicSystem(payload.system, systemPrompt);
    return restored;
  }
  if (resolvedApi === "openai-completions" || resolvedApi === "openai-responses") {
    const restored: JsonRecord = { ...payload };
    if (Array.isArray(payload.input)) {
      restored.input = rewriteSystemItems(payload.input, systemPrompt, false);
    } else if (Array.isArray(payload.messages)) {
      restored.messages = rewriteSystemItems(payload.messages, systemPrompt, false);
    } else if (!("instructions" in payload)) {
      throw new Error("Provider payload does not contain input, messages, or instructions");
    }
    if ("instructions" in payload) restored.instructions = systemPrompt;
    return restored;
  }
  throw new Error("Provider payload API is not supported by v4-anchor");
}

export const ANCHOR_STATE_ENTRY = "v4-anchor-state";

export type AnchorPhase = "off" | "bootstrap" | "in-flight" | "promoted";

export interface AnchorState {
  enabled: boolean;
  phase: AnchorPhase;
}

export interface AnchorSnapshot {
  state: AnchorState;
  baselineTools?: string[];
}

const OFF_STATE: AnchorState = { enabled: false, phase: "off" };
const VALID_PHASES = new Set<AnchorPhase>(["off", "bootstrap", "in-flight", "promoted"]);

export function isTargetModel(model: unknown): boolean {
  return isRecord(model)
    && typeof model.id === "string"
    && model.id.endsWith(TARGET_MODEL_SUFFIX)
    && isAnchorApi(model.api);
}

export function hasConversation(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    if (!isRecord(entry)) return false;
    if (entry.type === "message" || entry.type === "custom_message") return true;
    return entry.type === "compaction" || entry.type === "branch_summary";
  });
}

function parseBaselineTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((name) => typeof name === "string" && name.length > 0)) {
    return undefined;
  }
  if (new Set(value).size !== value.length) return undefined;
  return [...value];
}

export function readAnchorSnapshot(entries: readonly unknown[]): AnchorSnapshot {
  let snapshot: AnchorSnapshot = { state: { ...OFF_STATE } };
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== ANCHOR_STATE_ENTRY) {
      continue;
    }
    const data = entry.data;
    if (!isRecord(data) || typeof data.enabled !== "boolean" || typeof data.phase !== "string") {
      continue;
    }
    if (!VALID_PHASES.has(data.phase as AnchorPhase)) continue;
    const state: AnchorState = {
      enabled: data.enabled,
      phase: data.enabled ? data.phase as AnchorPhase : "off",
    };
    const baselineTools = state.enabled ? parseBaselineTools(data.baselineTools) : undefined;
    snapshot = baselineTools === undefined ? { state } : { state, baselineTools };
  }
  return snapshot;
}

export function readAnchorState(entries: readonly unknown[]): AnchorState {
  return readAnchorSnapshot(entries).state;
}

function selectedBootstrapTools(payloadTools: unknown[], api: AnchorApi): JsonRecord[] {
  const selectedTools: JsonRecord[] = [];
  const selectedNames = new Set<string>();
  for (const candidate of payloadTools) {
    if (!isRecord(candidate)) continue;
    const name = serializedToolName(candidate);
    if (name !== "bash" && name !== "str_replace_editor") continue;
    selectedNames.add(name);
    selectedTools.push(name === "bash" ? rewriteBashTool(candidate, api) : { ...candidate });
  }

  for (const requiredName of BOOTSTRAP_TOOL_NAMES) {
    if (!selectedNames.has(requiredName)) {
      throw new Error(`Provider payload is missing required bootstrap tool: ${requiredName}`);
    }
  }
  return selectedTools;
}

function setOutputTokenLimit(payload: JsonRecord, api: AnchorApi, maxOutputTokens: number): void {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("maxOutputTokens must be a positive safe integer");
  }

  if (api === "openai-responses") {
    payload.max_output_tokens = maxOutputTokens;
    delete payload.max_tokens;
    delete payload.max_completion_tokens;
    return;
  }
  if (api === "anthropic-messages") {
    payload.max_tokens = maxOutputTokens;
    delete payload.max_output_tokens;
    delete payload.max_completion_tokens;
    return;
  }

  if ("max_completion_tokens" in payload) {
    payload.max_completion_tokens = maxOutputTokens;
    delete payload.max_tokens;
  } else {
    payload.max_tokens = maxOutputTokens;
    delete payload.max_completion_tokens;
  }
  delete payload.max_output_tokens;
}

export function rewriteBootstrapPayload(
  payload: unknown,
  options: BootstrapPayloadOptions = {},
): unknown {
  if (!isRecord(payload)) {
    throw new Error("Provider payload must be an object");
  }
  const api = options.api ?? detectPayloadApi(payload);
  if (!api || !isAnchorApi(api)) {
    throw new Error("Provider payload API is not supported by v4-anchor");
  }
  if (!Array.isArray(payload.tools)) {
    throw new Error("Provider payload does not contain a tools array");
  }

  const selectedTools = selectedBootstrapTools(payload.tools, api);
  const modelId = options.modelId ?? TARGET_MODEL_SUFFIX;
  if (!modelId.endsWith(TARGET_MODEL_SUFFIX)) {
    throw new Error("Provider model id does not end with deepseek-v4-pro");
  }

  const rewritten: JsonRecord = {
    ...payload,
    model: modelId,
    stream: true,
    tools: selectedTools,
  };

  if (api === "openai-responses") {
    rewritten.store = false;
    delete rewritten.conversation;
    delete rewritten.previous_response_id;
    delete rewritten.prompt;
    delete rewritten.messages;
    delete rewritten.system;
    if ("instructions" in payload) rewritten.instructions = MINIMAL_PERSONA;
    if ("tool_choice" in payload) rewritten.tool_choice = "auto";
    if (Array.isArray(payload.input)) {
      validateBootstrapItems(payload.input, api);
      rewritten.input = rewriteSystemItems(payload.input);
    } else {
      throw new Error("Provider payload does not contain an input array");
    }
  } else if (api === "openai-completions") {
    delete rewritten.instructions;
    delete rewritten.system;
    delete rewritten.input;
    delete rewritten.conversation;
    delete rewritten.previous_response_id;
    delete rewritten.prompt;
    delete rewritten.store;
    if ("tool_choice" in payload) rewritten.tool_choice = "auto";
    if (Array.isArray(payload.messages)) {
      validateBootstrapItems(payload.messages, api);
      rewritten.messages = rewriteSystemItems(payload.messages);
    } else {
      throw new Error("Provider payload does not contain a messages array");
    }
  } else {
    delete rewritten.instructions;
    delete rewritten.input;
    delete rewritten.conversation;
    delete rewritten.previous_response_id;
    delete rewritten.prompt;
    delete rewritten.store;
    rewritten.system = rewriteAnthropicSystem(payload.system, MINIMAL_PERSONA);
    if ("tool_choice" in payload) rewritten.tool_choice = { type: "auto" };
    if (Array.isArray(payload.messages)) {
      validateBootstrapItems(payload.messages, api);
      rewritten.messages = [...payload.messages];
    } else {
      throw new Error("Provider payload does not contain a messages array");
    }
  }

  if (options.maxOutputTokens !== undefined) {
    setOutputTokenLimit(rewritten, api, options.maxOutputTokens);
  } else if (api === "openai-responses") {
    delete rewritten.max_tokens;
    delete rewritten.max_completion_tokens;
  } else if (api === "openai-completions") {
    delete rewritten.max_output_tokens;
  } else {
    delete rewritten.max_output_tokens;
    delete rewritten.max_completion_tokens;
  }

  return rewritten;
}
