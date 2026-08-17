import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AnchorPhase } from "../src/core.ts";
import { MINIMAL_PERSONA } from "../src/core.ts";
import { EDITOR_DESCRIPTION } from "../src/editor.ts";
import extension from "../index.ts";

const EXTENSION_PATH = resolve(fileURLToPath(new URL("../index.ts", import.meta.url)));

interface Runtime {
  pi: any;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  tools: Map<string, any>;
  activeTools: string[];
  entries: any[];
  model: any;
  notifications: Array<{ message: string; level: string }>;
  statuses: Map<string, string | undefined>;
}

type TestIntent = {
  enabled: boolean;
  hold?: true;
  minThinkingTokens?: number;
};
const testIntents = new WeakMap<Runtime, TestIntent>();

function createRuntime(initialEntries: any[] = [], model: any = targetModel()): Runtime {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const runtime: Runtime = {
    pi: undefined,
    commands,
    handlers,
    tools,
    activeTools: ["read", "bash", "edit", "write"],
    entries: [...initialEntries],
    model: undefined,
    notifications,
    statuses,
  };

  const builtins = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({
    name,
    description: `${name} builtin`,
    parameters: { type: "object", properties: {} },
    sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
  }));

  runtime.pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    refreshTools() {},
    getActiveTools: () => [...runtime.activeTools],
    getAllTools: () => [...builtins, ...[...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      sourceInfo: { source: "pi-v4-anchor", path: EXTENSION_PATH },
    }))],
    setActiveTools(names: string[]) {
      runtime.activeTools = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      runtime.entries.push({ type: "custom", customType, data });
    },
  };

  runtime.model = model;
  testIntents.set(runtime, { enabled: false });
  return runtime;
}

function loadExtension(runtime: Runtime, intent = testIntents.get(runtime)!): void {
  (extension as unknown as (pi: any, options?: {
    intentStore: {
      read(): TestIntent;
      write(intent: TestIntent): void;
    };
  }) => void)(runtime.pi, {
    intentStore: {
      read: () => ({ ...intent }),
      write: (next) => {
        intent.enabled = next.enabled;
        intent.hold = next.hold;
        intent.minThinkingTokens = next.minThinkingTokens;
      },
    },
  });
}

function targetModel(api: "openai-responses" | "openai-completions" | "anthropic-messages" = "openai-responses", provider = "AnyGateway") {
  return { provider, id: "deepseek-v4-pro", api };
}

function createContext(runtime: Runtime, model: any = targetModel(), entries = runtime.entries) {
  return {
    cwd: "C:/workspace/project",
    model,
    getSystemPrompt: () => "BASE PI SYSTEM PROMPT",
    isIdle: () => true,
    waitForIdle: async () => {},
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
    },
    ui: {
      notify(message: string, level: string) {
        runtime.notifications.push({ message, level });
      },
      setStatus(name: string, value: string | undefined) {
        runtime.statuses.set(name, value);
      },
    },
  };
}

async function emit(runtime: Runtime, eventName: string, event: any, ctx: any): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of runtime.handlers.get(eventName) ?? []) {
    results.push(await handler(event, ctx));
  }
  return results;
}

function command(runtime: Runtime) {
  const registered = runtime.commands.get("v4-anchor");
  assert.ok(registered, "v4-anchor command must be registered");
  return registered.handler;
}

test("starts disabled and on/off restores the exact baseline tool set", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);

  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.equal(runtime.tools.has("str_replace_editor"), true);
  assert.equal(runtime.activeTools.includes("str_replace_editor"), false);

  await command(runtime)("on", ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  assert.equal(runtime.tools.has("str_replace_editor"), true);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /bootstrap/);

  await command(runtime)("off", ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /off/);
  assert.deepEqual(runtime.entries.at(-1)?.data, { enabled: false, phase: "off" });
});

test("shares /v4-anchor threshold settings with fresh target Pi instances through the agent state file", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-v4-anchor-global-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const parent = createRuntime();
    extension(parent.pi);
    const parentContext = createContext(parent);
    await emit(parent, "session_start", { reason: "startup" }, parentContext);
    await command(parent)("on --min-thinking-tokens 2048", parentContext);

    assert.equal(existsSync(join(agentDir, "pi-v4-anchor-state.json")), true);

    const child = createRuntime();
    extension(child.pi);
    const childContext = createContext(child);
    await emit(child, "session_start", { reason: "startup" }, childContext);
    assert.deepEqual(child.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
    assert.match(child.statuses.get("v4-anchor") ?? "", /bootstrap/);
    assert.deepEqual(child.entries.at(-1)?.data, {
      enabled: true,
      phase: "bootstrap",
      minThinkingTokens: 2048,
      thinkingTokens: 0,
      baselineTools: ["read", "bash", "edit", "write"],
    });

    await command(parent)("off", parentContext);
    const later = createRuntime();
    extension(later.pi);
    const laterContext = createContext(later);
    await emit(later, "session_start", { reason: "startup" }, laterContext);
    assert.deepEqual(later.activeTools, ["read", "bash", "edit", "write"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("arms a globally enabled fresh Pi only after it selects a target model", async () => {
  const sharedIntent: TestIntent = { enabled: true };
  const nonTarget = { provider: "OpenAI", id: "gpt-5", api: "openai-responses" };
  const runtime = createRuntime([], nonTarget);
  loadExtension(runtime, sharedIntent);
  const ctx = createContext(runtime, nonTarget);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);

  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /standby/);

  const selected = targetModel("anthropic-messages", "child-provider");
  ctx.model = selected;
  await emit(runtime, "model_select", {
    model: selected,
    previousModel: nonTarget,
    source: "set",
  }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /bootstrap/);
});

test("does not re-arm a stale branch after switching through a non-target model", async () => {
  const runtime = createRuntime();
  const intent = { enabled: true };
  loadExtension(runtime, intent);
  const target = targetModel("openai-responses", "provider-a");
  const nonTarget = { provider: "OpenAI", id: "gpt-5", api: "openai-responses" };
  const ctx = createContext(runtime, target);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);

  ctx.model = nonTarget;
  await emit(runtime, "model_select", { model: nonTarget, previousModel: target, source: "set" }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);

  runtime.entries.push({ type: "message", message: { role: "user", content: "non-target work" } });
  ctx.model = target;
  await emit(runtime, "model_select", { model: target, previousModel: nonTarget, source: "set" }, ctx);

  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /standby/);
});

test("preserves Magic Context tools while narrowing only the bootstrap payload", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const originalGetAllTools = runtime.pi.getAllTools;
  const magicToolNames = ["ctx_search", "ctx_memory", "ctx_note", "ctx_expand", "ctx_reduce", "todowrite"];
  runtime.activeTools.push(...magicToolNames);
  runtime.pi.getAllTools = () => [
    ...originalGetAllTools(),
    ...magicToolNames.map((name) => ({
      name,
      description: `Magic Context ${name}`,
      sourceInfo: { source: "other-extension" },
    })),
  ];
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  const baseline = [...runtime.activeTools];

  await command(runtime)("on", ctx);
  assert.deepEqual(runtime.activeTools, [...baseline, "str_replace_editor"]);
  assert.deepEqual(
    runtime.pi.getAllTools().filter((tool: any) => magicToolNames.includes(tool.name)).map((tool: any) => tool.name),
    magicToolNames,
  );
  const request = (await emit(runtime, "before_provider_request", {
    payload: {
      input: [
        { role: "system", content: MINIMAL_PERSONA },
        { role: "user", content: "Use the available tools" },
      ],
      tools: [
        { type: "function", name: "bash", description: "bash", parameters: {} },
        { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
        ...magicToolNames.map((name) => ({ type: "function", name, description: name, parameters: {} })),
      ],
    },
  }, ctx))[0] as any;
  assert.deepEqual(request.tools.map((tool: any) => tool.name), ["bash", "str_replace_editor"]);
  assert.deepEqual(runtime.activeTools, [...baseline, "str_replace_editor"]);

  await emit(runtime, "message_end", {
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  }, ctx);
  assert.deepEqual(runtime.activeTools, baseline);
  assert.deepEqual(
    runtime.pi.getAllTools().filter((tool: any) => magicToolNames.includes(tool.name)).map((tool: any) => tool.name),
    magicToolNames,
  );
});

test("preserves an editor the user explicitly activated before on", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  runtime.pi.setActiveTools(["read", "bash", "edit", "write", "str_replace_editor"]);

  await command(runtime)("on", ctx);
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "bootstrap",
    baselineTools: ["read", "bash", "edit", "write", "str_replace_editor"],
  });

  await command(runtime)("off", ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);

  await emit(runtime, "session_start", { reason: "reload" }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  await emit(runtime, "session_tree", {}, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
});

test("off is a no-op for user tools when anchor is already disabled", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  runtime.pi.setActiveTools(["read", "bash", "edit", "write", "str_replace_editor"]);

  await command(runtime)("off", ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
});

test("refuses activation for another model or a non-fresh branch", async () => {
  const wrongModel = createRuntime([], { provider: "OpenAI", id: "gpt-5" });
  loadExtension(wrongModel);
  const wrongContext = createContext(wrongModel, wrongModel.model);
  await emit(wrongModel, "session_start", { reason: "startup" }, wrongContext);
  await command(wrongModel)("on", wrongContext);
  assert.deepEqual(wrongModel.activeTools, ["read", "bash", "edit", "write"]);
  const aliased = createRuntime([], {
    provider: "gateway",
    id: "gateway/deepseek-v4-pro",
    api: "openai-completions",
  });
  loadExtension(aliased);
  const aliasedContext = createContext(aliased, aliased.model);
  await emit(aliased, "session_start", { reason: "startup" }, aliasedContext);
  await command(aliased)("on", aliasedContext);
  assert.deepEqual(aliased.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);

  const existing = createRuntime([{ type: "message", message: { role: "user", content: "already started" } }]);
  loadExtension(existing);
  const existingContext = createContext(existing);
  await emit(existing, "session_start", { reason: "startup" }, existingContext);
  await command(existing)("on", existingContext);
  assert.deepEqual(existing.activeTools, ["read", "bash", "edit", "write"]);
  assert.match(existing.notifications.at(-1)?.message ?? "", /fresh target-model/i);
});

test("rewrites the first Responses request and promotes after a text-only assistant response", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);

  const beforeAgent = await emit(runtime, "before_agent_start", {
    prompt: "Implement the task",
    systemPrompt: "RESTRICTED BOOTSTRAP TOOL PROMPT",
    systemPromptOptions: {},
  }, ctx);
  assert.deepEqual(beforeAgent, [{ systemPrompt: MINIMAL_PERSONA }]);

  const request = {
    input: [
      { role: "system", content: MINIMAL_PERSONA },
      { role: "user", content: [{ type: "input_text", text: "Implement the task" }] },
    ],
    tools: [
      { type: "function", name: "bash", description: "normal", parameters: {} },
      { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
    ],
  };
  const result = (await emit(runtime, "before_provider_request", { payload: request }, ctx))[0] as any;
  assert.deepEqual(result.input[0], { role: "system", content: MINIMAL_PERSONA });
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "in-flight",
    baselineTools: ["read", "bash", "edit", "write"],
  });
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);

  await emit(runtime, "message_end", {
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "promoted",
    baselineTools: ["read", "bash", "edit", "write"],
  });

  const laterAgent = await emit(runtime, "before_agent_start", {
    prompt: "Continue",
    systemPrompt: "NEW TURN SYSTEM",
    systemPromptOptions: {},
  }, ctx);
  assert.deepEqual(laterAgent, [{ systemPrompt: MINIMAL_PERSONA }]);

  const nextTurnRequest = (await emit(runtime, "before_provider_request", {
    payload: {
      input: [{ role: "system", content: MINIMAL_PERSONA }, { role: "user", content: "Continue" }],
      tools: [],
    },
  }, ctx))[0] as any;
  assert.deepEqual(nextTurnRequest.input[0], { role: "system", content: MINIMAL_PERSONA });
  assert.equal(nextTurnRequest.input[1].role, "user");
  assert.match(JSON.stringify(nextTurnRequest.input[1]), /NEW TURN SYSTEM/);
  assert.deepEqual(nextTurnRequest.input.at(-1), { role: "user", content: "Continue" });
});

test("hold keeps the Minimal tool surface until manual promotion", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("hold", ctx);

  await emit(runtime, "before_provider_request", {
    payload: {
      input: [
        { role: "system", content: MINIMAL_PERSONA },
        { role: "user", content: "Implement the task" },
      ],
      tools: [
        { type: "function", name: "bash", description: "bash", parameters: {} },
        { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
        { type: "function", name: "read", description: "read", parameters: {} },
      ],
    },
  }, ctx);
  await emit(runtime, "message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Need another turn" }],
      stopReason: "stop",
      usage: { reasoning: 512 },
    },
  }, ctx);

  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "anchored",
    hold: true,
    baselineTools: ["read", "bash", "edit", "write"],
  });

  const continuation = (await emit(runtime, "before_provider_request", {
    payload: {
      input: [
        { role: "system", content: "BASE PI SYSTEM PROMPT" },
        { role: "user", content: "Implement the task" },
        { role: "assistant", content: "Need another turn" },
        { role: "user", content: "Continue" },
      ],
      tools: [
        { type: "function", name: "read", description: "read", parameters: {} },
        { type: "function", name: "bash", description: "bash", parameters: {} },
        { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
      ],
      max_output_tokens: 4096,
    },
  }, ctx))[0] as any;

  assert.deepEqual(continuation.tools.map((tool: any) => tool.name), ["bash", "str_replace_editor"]);
  assert.deepEqual(continuation.input.slice(1), [
    { role: "user", content: "Implement the task" },
    { role: "assistant", content: "Need another turn" },
    { role: "user", content: "Continue" },
  ]);
  assert.equal(continuation.input[0].content, MINIMAL_PERSONA);
  assert.equal(continuation.max_output_tokens, 4096);

  await command(runtime)("promote", ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "promoted",
    baselineTools: ["read", "bash", "edit", "write"],
  });
});

test("promotes on the request after cumulative reasoning exceeds the configured threshold", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on --min-thinking-tokens 100", ctx);

  const firstPayload = {
    input: [
      { role: "system", content: "BASE PI SYSTEM PROMPT" },
      { role: "user", content: "Implement the task" },
    ],
    tools: [
      { type: "function", name: "read", description: "read", parameters: {} },
      { type: "function", name: "bash", description: "bash", parameters: {} },
      { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
    ],
  };
  await emit(runtime, "before_provider_request", { payload: firstPayload }, ctx);
  await emit(runtime, "message_end", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "pwd" } }],
      stopReason: "toolUse",
      usage: { reasoning: 100 },
    },
  }, ctx);

  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "in-flight",
    minThinkingTokens: 100,
    thinkingTokens: 100,
    baselineTools: ["read", "bash", "edit", "write"],
  });

  await emit(runtime, "tool_result", { toolName: "bash" }, ctx);
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "anchored",
    minThinkingTokens: 100,
    thinkingTokens: 100,
    baselineTools: ["read", "bash", "edit", "write"],
  });
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);

  const secondPayload = {
    input: [
      { role: "system", content: "BASE PI SYSTEM PROMPT" },
      { role: "user", content: "Implement the task" },
      { role: "assistant", content: "tool call" },
      { role: "user", content: "tool result" },
    ],
    tools: firstPayload.tools,
  };
  const second = (await emit(runtime, "before_provider_request", { payload: secondPayload }, ctx))[0] as any;
  assert.deepEqual(second.tools.map((tool: any) => tool.name), ["bash", "str_replace_editor"]);

  await emit(runtime, "message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Ready" }],
      stopReason: "stop",
      usage: { reasoning: 1 },
    },
  }, ctx);

  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "promoted",
    baselineTools: ["read", "bash", "edit", "write"],
  });

  const third = (await emit(runtime, "before_provider_request", { payload: secondPayload }, ctx))[0] as any;
  assert.deepEqual(third.tools.map((tool: any) => tool.name), ["read", "bash", "str_replace_editor"]);
  assert.equal(third.input.some((item: any) => (
    item.role === "user"
    && Array.isArray(item.content)
    && item.content.some((part: any) => /<v4-anchor-context>/.test(part.text ?? ""))
  )), true);
});

test("rewrites Chat Completions and Anthropic Messages requests through the runtime lifecycle", async () => {
  for (const api of ["openai-completions", "anthropic-messages"] as const) {
    const runtime = createRuntime([], targetModel(api, "unrelated-provider"));
    loadExtension(runtime);
    const ctx = createContext(runtime, runtime.model);
    await emit(runtime, "session_start", { reason: "startup" }, ctx);
    await command(runtime)("on", ctx);

    const payload = api === "openai-completions"
      ? {
        model: "unrelated-provider/deepseek-v4-pro",
        messages: [
          { role: "system", content: "Full system" },
          { role: "user", content: "Use tools" },
        ],
        tools: [
          { type: "function", function: { name: "bash", description: "bash", parameters: {} } },
          { type: "function", function: { name: "str_replace_editor", description: "editor", parameters: {} } },
          { type: "function", function: { name: "ctx_search", description: "magic", parameters: {} } },
        ],
        max_tokens: 100,
      }
      : {
        model: "unrelated-provider/deepseek-v4-pro",
        system: [{ type: "text", text: "Full system" }],
        messages: [{ role: "user", content: [{ type: "text", text: "Use tools" }] }],
        tools: [
          { name: "bash", description: "bash", input_schema: {} },
          { name: "str_replace_editor", description: "editor", input_schema: {} },
          { name: "ctx_search", description: "magic", input_schema: {} },
        ],
        max_tokens: 100,
      };

    const result = (await emit(runtime, "before_provider_request", { payload }, ctx))[0] as any;
    assert.deepEqual(result.tools.map((tool: any) => tool.function?.name ?? tool.name), ["bash", "str_replace_editor"]);
    if (api === "openai-completions") {
      assert.deepEqual(result.messages[0], { role: "system", content: MINIMAL_PERSONA });
    } else {
      assert.deepEqual(result.system, [{ type: "text", text: MINIMAL_PERSONA }]);
    }

    await emit(runtime, "message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
    }, ctx);
    assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  }
});

test("does not restore old baseline tools after a promoted target-to-target model switch", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);
  await emit(runtime, "before_provider_request", {
    payload: {
      input: [
        { role: "system", content: MINIMAL_PERSONA },
        { role: "user", content: "Implement the task" },
      ],
      tools: [
        { type: "function", name: "bash", description: "bash", parameters: {} },
        { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
      ],
    },
  }, ctx);
  await emit(runtime, "message_end", {
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  }, ctx);
  runtime.pi.setActiveTools(["read", "bash", "edit", "write", "grep"]);

  await emit(runtime, "model_select", {
    model: { provider: "provider-b", id: "deepseek-v4-pro", api: "anthropic-messages" },
    previousModel: targetModel("openai-responses", "provider-a"),
    source: "set",
  }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "grep"]);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /promoted/);
});

test("fails closed to the baseline request when bootstrap payload validation fails", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);

  const result = (await emit(runtime, "before_provider_request", {
    payload: {
      input: [
        { role: "system", content: MINIMAL_PERSONA },
        { role: "user", content: "Implement the task" },
      ],
      tools: [{ type: "function", name: "bash", description: "bash", parameters: {} }],
    },
  }, ctx))[0] as any;

  assert.equal(result.input[0].content, "BASE PI SYSTEM PROMPT");
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(runtime.entries.at(-1)?.data, { enabled: false, phase: "off" });
  assert.match(runtime.notifications.at(-1)?.message ?? "", /payload validation failed/i);
});

test("keeps the Minimal persona after a tool result and never overrides Pi bash", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  const fullPrompt = "BASE PI SYSTEM PROMPT\n\n<session-history>magic before anchor</session-history>";
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);
  await emit(runtime, "before_agent_start", {
    prompt: "Implement the task",
    systemPrompt: fullPrompt,
    systemPromptOptions: {},
  }, ctx);
  await emit(runtime, "before_provider_request", {
    payload: {
      input: [
        { role: "system", content: MINIMAL_PERSONA },
        { role: "user", content: "Implement the task" },
      ],
      tools: [
        { type: "function", name: "bash", description: "normal", parameters: {} },
        { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
      ],
    },
  }, ctx);
  await emit(runtime, "tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] }, ctx);

  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  const entries = runtime.entries.filter((entry) => entry.customType === "v4-anchor-state");
  assert.deepEqual(entries.at(-1)?.data, {
    enabled: true,
    phase: "promoted",
    baselineTools: ["read", "bash", "edit", "write"],
  });

  const continuation = (await emit(runtime, "before_provider_request", {
    payload: {
      input: [{ role: "system", content: MINIMAL_PERSONA }, { role: "user", content: "Continue" }],
      tools: [],
    },
  }, ctx))[0] as any;
  assert.deepEqual(continuation.input[0], { role: "system", content: MINIMAL_PERSONA });
  assert.equal(continuation.input[1].role, "user");
  assert.match(JSON.stringify(continuation.input[1]), /magic before anchor/);
  assert.deepEqual(continuation.input.at(-1), { role: "user", content: "Continue" });
  assert.equal(runtime.tools.get("str_replace_editor")?.name, "str_replace_editor");
});

test("moves a Magic Context block appended after the anchor into persistent user context", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  const magicBlock = "\n\n<session-history>magic after anchor</session-history>";
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);
  await emit(runtime, "before_agent_start", {
    prompt: "Implement the task",
    systemPrompt: "BASE PI SYSTEM PROMPT",
    systemPromptOptions: {},
  }, ctx);

  const bootstrap = (await emit(runtime, "before_provider_request", {
    payload: {
      input: [
        { role: "system", content: `${MINIMAL_PERSONA}${magicBlock}` },
        { role: "user", content: "Implement the task" },
      ],
      tools: [
        { type: "function", name: "bash", description: "normal", parameters: {} },
        { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
      ],
    },
  }, ctx))[0] as any;
  assert.equal(bootstrap.input[0].content, MINIMAL_PERSONA);

  await emit(runtime, "tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] }, ctx);
  const continuation = (await emit(runtime, "before_provider_request", {
    payload: {
      input: [{ role: "system", content: MINIMAL_PERSONA }, { role: "user", content: "Continue" }],
      tools: [],
    },
  }, ctx))[0] as any;
  assert.equal(continuation.input[0].content, MINIMAL_PERSONA);
  assert.equal(continuation.input[1].role, "user");
  assert.match(JSON.stringify(continuation.input[1]), /magic after anchor/);
});

test("keeps an armed anchor when switching between target providers", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime, {
    provider: "provider-a",
    id: "deepseek-v4-pro",
    api: "openai-completions",
  });
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);
  await emit(runtime, "model_select", {
    model: { provider: "provider-b", id: "deepseek-v4-pro", api: "anthropic-messages" },
    previousModel: { provider: "provider-a", id: "deepseek-v4-pro", api: "openai-completions" },
    source: "set",
  }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  assert.deepEqual(runtime.entries.at(-1)?.data, {
    enabled: true,
    phase: "bootstrap",
    baselineTools: ["read", "bash", "edit", "write"],
  });
});

test("disables an armed anchor when the model or bash implementation changes", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);

  ctx.model = { provider: "OpenAI", id: "gpt-5" };
  await emit(runtime, "before_provider_request", {
    payload: {
      input: [{ role: "system", content: MINIMAL_PERSONA }],
      tools: [],
    },
  }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(runtime.entries.at(-1)?.data, { enabled: false, phase: "off" });

  const bashOverride = createRuntime();
  loadExtension(bashOverride);
  const bashContext = createContext(bashOverride);
  await emit(bashOverride, "session_start", { reason: "startup" }, bashContext);
  await command(bashOverride)("on", bashContext);
  const getAllTools = bashOverride.pi.getAllTools;
  bashOverride.pi.getAllTools = () => getAllTools().map((tool: any) => tool.name === "bash"
    ? { ...tool, sourceInfo: { source: "other-extension" } }
    : tool);
  await emit(bashOverride, "before_provider_request", {
    payload: {
      input: [{ role: "system", content: MINIMAL_PERSONA }],
      tools: [],
    },
  }, bashContext);
  assert.deepEqual(bashOverride.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(bashOverride.entries.at(-1)?.data, { enabled: false, phase: "off" });
});

test("restores an armed state on reload only when the branch is still fresh", async () => {
  const armed = createRuntime([
    { type: "custom", customType: "v4-anchor-state", data: { enabled: true, phase: "bootstrap" } },
  ]);
  loadExtension(armed, { enabled: true });
  const armedContext = createContext(armed);
  await emit(armed, "session_start", { reason: "resume" }, armedContext);
  assert.deepEqual(armed.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);

  const stale = createRuntime([
    { type: "message", message: { role: "user", content: "already sent" } },
    { type: "custom", customType: "v4-anchor-state", data: { enabled: true, phase: "bootstrap" } },
  ]);
  loadExtension(stale, { enabled: true });
  const staleContext = createContext(stale);
  await emit(stale, "session_start", { reason: "resume" }, staleContext);
  assert.deepEqual(stale.activeTools, ["read", "bash", "edit", "write"]);
  assert.match(stale.notifications.at(-1)?.message ?? "", /closed/i);
});

test("disables an armed anchor on compaction and restores tools before session replacement", async () => {
  const compacted = createRuntime();
  loadExtension(compacted);
  const compactedContext = createContext(compacted);
  await emit(compacted, "session_start", { reason: "startup" }, compactedContext);
  await command(compacted)("on", compactedContext);
  await emit(compacted, "session_compact", { reason: "manual" }, compactedContext);
  assert.deepEqual(compacted.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(compacted.entries.at(-1)?.data, { enabled: false, phase: "off" });

  const replaced = createRuntime();
  loadExtension(replaced);
  const replacedContext = createContext(replaced);
  await emit(replaced, "session_start", { reason: "startup" }, replacedContext);
  await command(replaced)("on", replacedContext);
  await emit(replaced, "session_shutdown", { reason: "reload" }, replacedContext);
  assert.deepEqual(replaced.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(replaced.entries.at(-1)?.data, {
    enabled: true,
    phase: "bootstrap",
    baselineTools: ["read", "bash", "edit", "write"],
  });
});

test("keeps an anchored hold branch minimal across reload and fork", async () => {
  for (const reason of ["reload", "fork"] as const) {
    const entries = [
      {
        type: "custom",
        customType: "v4-anchor-state",
        data: {
          enabled: true,
          phase: "anchored",
          hold: true,
          baselineTools: ["read", "bash", "edit", "write"],
        },
      },
      { type: "message", message: { role: "user", content: "completed first turn" } },
    ];
    const runtime = createRuntime(entries);
    loadExtension(runtime, { enabled: true, hold: true });
    const ctx = createContext(runtime);

    await emit(runtime, "session_start", { reason }, ctx);

    assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
    assert.match(runtime.statuses.get("v4-anchor") ?? "", /anchored:hold/);
    assert.deepEqual(
      runtime.entries.filter((entry) => entry.customType === "v4-anchor-state").at(-1)?.data,
      entries[0]!.data,
    );
  }
});

test("keeps a promoted target-model branch promoted across reload and fork", async () => {
  for (const reason of ["reload", "fork"] as const) {
    const entries = [
      {
        type: "custom",
        customType: "v4-anchor-state",
        data: {
          enabled: true,
          phase: "promoted",
          baselineTools: ["read", "bash", "edit", "write"],
        },
      },
      { type: "message", message: { role: "user", content: "completed task" } },
    ];
    const runtime = createRuntime(entries);
    runtime.activeTools = ["bash", "str_replace_editor"];
    loadExtension(runtime, { enabled: true });
    const ctx = createContext(runtime);

    await emit(runtime, "session_start", { reason }, ctx);

    assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
    assert.match(runtime.statuses.get("v4-anchor") ?? "", /promoted/);
    assert.deepEqual(
      runtime.entries.filter((entry) => entry.customType === "v4-anchor-state").at(-1)?.data,
      entries[0]!.data,
    );
  }
});

test("rebuilds armed and off state when navigating the session tree", async () => {
  const runtime = createRuntime();
  const intent = { enabled: false };
  loadExtension(runtime, intent);
  let branch: any[] = [];
  const ctx = createContext(runtime, targetModel(), branch);
  ctx.sessionManager.getBranch = () => branch;
  await emit(runtime, "session_start", { reason: "startup" }, ctx);

  intent.enabled = true;
  branch = [{
    type: "custom",
    customType: "v4-anchor-state",
    data: {
      enabled: true,
      phase: "bootstrap",
      baselineTools: ["read", "bash", "edit", "write"],
    },
  }];
  await emit(runtime, "session_tree", { newLeafId: "armed", oldLeafId: "off" }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /bootstrap/);

  intent.enabled = false;
  branch = [{
    type: "custom",
    customType: "v4-anchor-state",
    data: { enabled: false, phase: "off" },
  }];
  await emit(runtime, "session_tree", { newLeafId: "off", oldLeafId: "armed" }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.match(runtime.statuses.get("v4-anchor") ?? "", /off/);
});

test("leaves another extension's editor active while refusing anchor activation", async () => {
  const runtime = createRuntime();
  loadExtension(runtime);
  const getAllTools = runtime.pi.getAllTools;
  runtime.pi.getAllTools = () => getAllTools().map((tool: any) => tool.name === "str_replace_editor"
    ? {
      ...tool,
      description: EDITOR_DESCRIPTION,
      sourceInfo: { source: "other-extension", path: "C:/workspace/other-extension/editor.ts" },
    }
    : tool);
  runtime.activeTools.push("str_replace_editor");
  const ctx = createContext(runtime);

  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  await command(runtime)("on", ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write", "str_replace_editor"]);
  assert.match(runtime.notifications.at(-1)?.message ?? "", /another tool owns/i);
});

test("refuses activation if another extension has replaced Pi's bash", async () => {
  const runtime = createRuntime();
  const originalGetAllTools = runtime.pi.getAllTools;
  runtime.pi.getAllTools = () => [
    ...originalGetAllTools().map((tool: any) => tool.name === "bash"
      ? { ...tool, sourceInfo: { source: "other-extension", path: "other.ts" } }
      : tool),
  ];
  loadExtension(runtime);
  const ctx = createContext(runtime);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  await command(runtime)("on", ctx);
  assert.deepEqual(runtime.activeTools, ["read", "bash", "edit", "write"]);
  assert.match(runtime.notifications.at(-1)?.message ?? "", /bash.*override/i);
});
