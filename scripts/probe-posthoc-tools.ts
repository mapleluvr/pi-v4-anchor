import assert from "node:assert/strict";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  MINIMAL_BASH_DESCRIPTION,
  MINIMAL_BASH_PARAMETERS,
  MINIMAL_PERSONA,
} from "../src/core.ts";

if (!process.argv.includes("--run-paid")) {
  throw new Error("This script makes paid model requests. Re-run with --run-paid to confirm.");
}

type ProbeModel = {
  id?: string;
  api?: string;
  provider?: string;
};

type ProbeContentPart = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type ProbeAssistantMessage = {
  role: "assistant";
  content: ProbeContentPart[];
  stopReason?: string;
  rawStopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: Record<string, unknown>;
  };
};

type ProbeRuntime = {
  getModels(): ProbeModel[];
  getModel(provider: string, modelId: string): ProbeModel | undefined;
  getAvailableSnapshot(): ProbeModel[];
  hasConfiguredAuth(provider: string): boolean;
  getAuth(model: ProbeModel): Promise<unknown>;
  complete(model: unknown, context: unknown, options?: unknown): Promise<ProbeAssistantMessage>;
};

const sourceAgentDir = getAgentDir();
const tempAgentDir = await mkdtemp(join(tmpdir(), "pi-v4-anchor-probe-"));

async function copyIfPresent(name: string): Promise<void> {
  try {
    await access(join(sourceAgentDir, name));
  } catch {
    return;
  }
  await copyFile(join(sourceAgentDir, name), join(tempAgentDir, name));
}

const PROBE_PING_SCHEMA = {
  name: "probe_ping",
  description: "Send a probe ping with a message",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The ping message to send" },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

function posthocToolsBlock(toolSchemas: string): string {
  return `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<｜DSML｜tool_calls>" block like the following:

<｜DSML｜tool_calls>
<｜DSML｜invoke name="$TOOL_NAME">
<｜DSML｜parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</｜DSML｜parameter>
...
</｜DSML｜invoke>
<｜DSML｜invoke name="$TOOL_NAME2">
...
</｜DSML｜invoke>
</｜DSML｜tool_calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by <think>), you MUST output your complete reasoning inside <think>...</think> BEFORE any tool calls or final response.

Otherwise, output directly after </think> with tool calls or final response.

### Available Tool Schemas

${toolSchemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.`;
}

function userMessage(content: string): unknown {
  return { role: "user", content, timestamp: Date.now() };
}

function toolCallNames(message: ProbeAssistantMessage): string[] {
  return message.content
    .filter((part) => part.type === "toolCall" && typeof part.name === "string")
    .map((part) => part.name as string);
}

function contentText(message: ProbeAssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

try {
  await Promise.all([copyIfPresent("auth.json"), copyIfPresent("models.json")]);
  const rt = (await ModelRuntime.create({
    authPath: join(tempAgentDir, "auth.json"),
    modelsPath: join(tempAgentDir, "models.json"),
    refreshOnCreate: false,
  })) as unknown as ProbeRuntime;

  const requestedProvider = process.env.PI_V4_ANCHOR_PROVIDER;
  const requestedModelId = process.env.PI_V4_ANCHOR_MODEL ?? "deepseek-v4-pro";
  const requestedApi = process.env.PI_V4_ANCHOR_API;

  const catalogModels = rt.getModels();
  const availableModels = rt.getAvailableSnapshot();
  const authenticatedModels = catalogModels.filter((candidate) => (
    typeof candidate.provider === "string" && rt.hasConfiguredAuth(candidate.provider)
  ));
  const modelPool = requestedProvider
    ? [rt.getModel(requestedProvider, requestedModelId)]
    : [
        ...authenticatedModels,
        ...availableModels,
        ...catalogModels.filter((candidate) => !availableModels.some((available) => (
          available.provider === candidate.provider && available.id === candidate.id
        ))),
      ];

  const candidates = modelPool.filter((candidate): candidate is ProbeModel => (
    candidate !== undefined
    && typeof candidate.id === "string"
    && (candidate.id.endsWith("deepseek-v4-pro") || candidate.id.endsWith("deepseek-v4-flash"))
    && (candidate.api === "openai-completions"
      || candidate.api === "openai-responses"
      || candidate.api === "anthropic-messages")
    && (!requestedApi || candidate.api === requestedApi)
  ));

  let model = candidates.find((candidate) => (
    typeof candidate.provider === "string" && rt.hasConfiguredAuth(candidate.provider)
  ));
  if (!model) {
    for (const candidate of candidates) {
      if (await rt.getAuth(candidate)) {
        model = candidate;
        break;
      }
    }
  }
  assert.ok(
    model,
    `No supported deepseek-v4-pro or deepseek-v4-flash model was found${requestedProvider ? ` for ${requestedProvider}` : ""}`,
  );

  const bashTool = {
    name: "bash",
    description: MINIMAL_BASH_DESCRIPTION,
    parameters: MINIMAL_BASH_PARAMETERS,
  };

  const control = await rt.complete(model, {
    systemPrompt: MINIMAL_PERSONA,
    messages: [
      userMessage(
        "Use the bash tool exactly once to run: printf PROBE_DECLARED_OK. "
        + "After the tool call, stop; do not send a final text answer.",
      ),
    ],
    tools: [bashTool],
  }, { maxTokens: 1024, reasoning: "low" });

  const posthoc = await rt.complete(model, {
    systemPrompt: MINIMAL_PERSONA,
    messages: [
      userMessage(
        `${posthocToolsBlock(JSON.stringify(PROBE_PING_SCHEMA))}\n\n`
        + "Call probe_ping with message 'PROBE_POSTHOC_OK'. "
        + "Do not call bash and do not send a final text answer.",
      ),
    ],
    tools: [bashTool],
  }, { maxTokens: 1024, reasoning: "low" });

  const controlCalls = toolCallNames(control);
  const posthocCalls = toolCallNames(posthoc);
  let verdict: string;
  if (posthocCalls.includes("probe_ping")) {
    verdict = "LIBERAL: server returned a tool call for a tool not declared in the tools parameter.";
  } else if (posthoc.stopReason === "error" || posthoc.errorMessage) {
    verdict = `ERROR: request failed (stopReason=${posthoc.stopReason} error=${posthoc.errorMessage ?? ""}). Inconclusive; inspect details.`;
  } else if (posthocCalls.length > 0) {
    verdict = `STRICT-ish: model called declared tool(s) ${JSON.stringify(posthocCalls)} instead of undeclared probe_ping. Server likely constrains tool names.`;
  } else {
    verdict = "INCONCLUSIVE: model neither called probe_ping nor a declared tool. Inspect text output.";
  }

  console.log(JSON.stringify({
    probe: "posthoc-tool-definitions",
    model: { id: model.id, api: model.api, provider: model.provider },
    control: {
      stopReason: control.stopReason,
      toolCalls: controlCalls,
      text: contentText(control),
      errorMessage: control.errorMessage,
      usage: control.usage,
    },
    posthoc: {
      stopReason: posthoc.stopReason,
      toolCalls: posthocCalls,
      text: contentText(posthoc),
      errorMessage: posthoc.errorMessage,
      usage: posthoc.usage,
    },
    verdict,
  }, null, 2));
} finally {
  await rm(tempAgentDir, { recursive: true, force: true });
}
