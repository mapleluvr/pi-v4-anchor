import assert from "node:assert/strict";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MINIMAL_PERSONA } from "../src/core.ts";

if (!process.argv.includes("--run-paid")) {
  throw new Error("This script makes a paid model request. Re-run with --run-paid to confirm.");
}

const toolMode = process.argv.includes("--tool");
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceAgentDir = getAgentDir();
const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-v4-anchor-live-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = tempAgentDir;
const tempProjectDir = await mkdtemp(join(tmpdir(), "pi-v4-anchor-live-project-"));
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

type CapturedPayload = {
  api: string;
  roles: unknown[];
  userTexts: string[];
  systemText: string;
  toolNames: unknown[];
  maxOutputTokens: unknown;
  reasoning: unknown;
};

async function copyIfPresent(name: string): Promise<void> {
  const source = join(sourceAgentDir, name);
  try {
    await access(source);
  } catch {
    return;
  }
  await copyFile(source, join(tempAgentDir, name));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => (
      typeof part === "object"
      && part !== null
      && (((part as { type?: unknown }).type === "text") || ((part as { type?: unknown }).type === "input_text"))
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("");
}

function toolName(tool: Record<string, unknown>): unknown {
  if (typeof tool.name === "string") return tool.name;
  const fn = tool.function;
  return typeof fn === "object" && fn !== null && typeof (fn as { name?: unknown }).name === "string"
    ? (fn as { name: string }).name
    : undefined;
}

function payloadSystemText(payload: Record<string, unknown>): string {
  if ("system" in payload) return textOf(payload.system);
  const messages = Array.isArray(payload.input) ? payload.input : payload.messages;
  if (!Array.isArray(messages)) return "";
  const system = messages.find((item) => (
    typeof item === "object"
    && item !== null
    && (((item as { role?: unknown }).role === "system") || ((item as { role?: unknown }).role === "developer"))
  )) as { content?: unknown } | undefined;
  return textOf(system?.content);
}

function payloadRoles(payload: Record<string, unknown>): unknown[] {
  const messages = Array.isArray(payload.input) ? payload.input : payload.messages;
  return Array.isArray(messages)
    ? messages.map((item) => typeof item === "object" && item !== null ? (item as { role?: unknown }).role : undefined)
    : [];
}

function payloadUserTexts(payload: Record<string, unknown>): string[] {
  const messages = Array.isArray(payload.input) ? payload.input : payload.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((item) => (
    typeof item === "object"
    && item !== null
    && (item as { role?: unknown }).role === "user"
      ? [textOf((item as { content?: unknown }).content)]
      : []
  ));
}

function maxOutputTokens(payload: Record<string, unknown>): unknown {
  return payload.max_output_tokens ?? payload.max_completion_tokens ?? payload.max_tokens;
}

function reasoningConfig(payload: Record<string, unknown>): unknown {
  return payload.reasoning
    ?? payload.reasoning_effort
    ?? payload.thinking
    ?? payload.enable_thinking;
}


function supportedApi(api: unknown): api is "openai-responses" | "openai-completions" | "anthropic-messages" {
  return api === "openai-responses" || api === "openai-completions" || api === "anthropic-messages";
}

try {
  await Promise.all([copyIfPresent("auth.json"), copyIfPresent("models.json")]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(tempAgentDir, "auth.json"),
    modelsPath: join(tempAgentDir, "models.json"),
    refreshOnCreate: false,
  });

  const requestedProvider = process.env.PI_V4_ANCHOR_PROVIDER;
  const requestedModelId = process.env.PI_V4_ANCHOR_MODEL ?? "deepseek-v4-pro";
  const requestedApi = process.env.PI_V4_ANCHOR_API;
  const catalogModels = modelRuntime.getModels();
  const availableModels = modelRuntime.getAvailableSnapshot();
  const authenticatedModels = catalogModels.filter((candidate) => modelRuntime.hasConfiguredAuth(candidate.provider));
  const modelPool = requestedProvider
    ? [modelRuntime.getModel(requestedProvider, requestedModelId)]
    : [...authenticatedModels, ...availableModels, ...catalogModels.filter((candidate) => !availableModels.some((available) => (
      available.provider === candidate.provider && available.id === candidate.id
    )))];
  const candidates = modelPool.filter((candidate): candidate is NonNullable<typeof candidate> => (
    candidate !== undefined
    && typeof candidate.id === "string"
    && candidate.id.endsWith("deepseek-v4-pro")
    && (!requestedApi || candidate.api === requestedApi)
  ));
  let configuredModel = candidates.find((candidate) => supportedApi(candidate.api) && modelRuntime.hasConfiguredAuth(candidate.provider));
  if (!configuredModel) {
    for (const candidate of candidates) {
      if (!supportedApi(candidate.api)) continue;
      if (await modelRuntime.getAuth(candidate)) {
        configuredModel = candidate;
        break;
      }
    }
  }
  assert.ok(configuredModel, `No supported model id ending in deepseek-v4-pro was found${requestedProvider ? ` for ${requestedProvider}` : ""}`);
  assert.ok(supportedApi(configuredModel.api), `Unsupported anchor API: ${configuredModel.api}`);
  const model = { ...configuredModel, maxTokens: 2_048 };

  const captured: CapturedPayload[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: tempProjectDir,
    agentDir: tempAgentDir,
    additionalExtensionPaths: [join(projectRoot, "index.ts")],
    extensionFactories: [{
      name: "capture-anchor-payload",
      hidden: true,
      factory(pi) {
        pi.on("before_provider_request", (event) => {
          const payload = event.payload as Record<string, unknown>;
          const tools = Array.isArray(payload.tools) ? payload.tools as Array<Record<string, unknown>> : [];
          captured.push({
            api: model.api,
            roles: payloadRoles(payload),
            userTexts: payloadUserTexts(payload),
            systemText: payloadSystemText(payload),
            toolNames: tools.map(toolName),
            maxOutputTokens: maxOutputTokens(payload),
            reasoning: reasoningConfig(payload),
          });
        });
      },
    }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "BASE LIVE SMOKE SYSTEM PROMPT",
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    cwd: tempProjectDir,
    agentDir: tempAgentDir,
    model,
    thinkingLevel: "max",
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(tempProjectDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  session = created.session;
  const extensionErrors: string[] = [];
  await session.bindExtensions({
    mode: "print",
    onError(error) {
      extensionErrors.push(`${error.event}: ${error.error}`);
    },
  });

  await session.prompt("/v4-anchor on");
  assert.deepEqual(session.getActiveToolNames(), ["read", "bash", "edit", "write", "str_replace_editor"]);
  await session.prompt(toolMode
    ? "Use the bash tool exactly once to run: printf ANCHOR_TOOL_OK. Then reply exactly ANCHOR_TOOL_OK."
    : "Return exactly ANCHOR_OK. Do not call tools.");

  assert.deepEqual(extensionErrors, []);
  assert.ok(captured[0], "no provider payload was captured");
  assert.equal(captured[0].systemText, MINIMAL_PERSONA);
  assert.deepEqual(captured[0].toolNames, ["bash", "str_replace_editor"]);
  assert.equal(captured[0].maxOutputTokens, 2_048);
  assert.notEqual(captured[0].reasoning, undefined, "max thinking was not serialized");

  if (toolMode) {
    assert.ok(captured[1], "the model did not make a tool call and continuation request");
    assert.equal(captured[1].systemText, MINIMAL_PERSONA);
    assert.ok(
      captured[1].userTexts.some((text) => (
        text.includes("<v4-anchor-context>")
        && text.includes("BASE LIVE SMOKE SYSTEM PROMPT")
      )),
      "the persistent continuation did not receive the original Pi prompt as user context",
    );
    assert.deepEqual(captured[1].toolNames, ["read", "bash", "edit", "write"]);
    assert.equal(captured[1].maxOutputTokens, 2_048);
    assert.notEqual(captured[1].reasoning, undefined, "max thinking was not serialized on continuation");
  } else {
    assert.equal(captured.length, 1);
  }
  assert.deepEqual(session.getActiveToolNames(), ["read", "bash", "edit", "write"]);

  const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
  assert.ok(assistant, "the provider returned no assistant message");
  assert.match(textOf(assistant.content), toolMode ? /ANCHOR_TOOL_OK/ : /^ANCHOR_OK$/);
  console.log(JSON.stringify({
    api: model.api,
    model: model.id,
    mode: toolMode ? "tool-continuation" : "text-only",
    payloads: captured,
    assistantText: textOf(assistant.content),
    activeToolsAfterResponse: session.getActiveToolNames(),
  }, null, 2));
} finally {
  session?.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await Promise.all([
    rm(tempAgentDir, { recursive: true, force: true }),
    rm(tempProjectDir, { recursive: true, force: true }),
  ]);
}
