import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../src/core.ts";
import {
  MINIMAL_PERSONA,
  captureContinuationSystemPrompt,
  hasConversation,
  isTargetModel,
  normalizeEditorPath,
  readAnchorSnapshot,
  readAnchorState,
  restoreSystemPrompt,
  rewriteBootstrapPayload,
  rewriteMinimalPayload,
} from "../src/core.ts";

test("normalizes Windows-native, MSYS, and WSL paths without guessing a drive", () => {
  assert.equal(normalizeEditorPath("c:/work/repo/file.ts", "win32"), "C:\\work\\repo\\file.ts");
  assert.equal(normalizeEditorPath("C:/work/repo/file.ts", "win32"), "C:\\work\\repo\\file.ts");
  assert.equal(normalizeEditorPath("/c/work/repo/file.ts", "win32"), "C:\\work\\repo\\file.ts");
  assert.equal(normalizeEditorPath("/mnt/c/work/repo/file.ts", "win32"), "C:\\work\\repo\\file.ts");
  assert.equal(normalizeEditorPath("@D:\\work\\file.ts", "win32"), "D:\\work\\file.ts");
  assert.throws(
    () => normalizeEditorPath("/repo/file.ts", "win32"),
    /drive-qualified Windows path/i,
  );
});

test("rewrites an OpenAI Responses bootstrap payload without leaking normal tools", () => {
  const userItem = {
    role: "user",
    content: [{ type: "input_text", text: "Implement the task" }],
  };
  const payload = {
    model: "sampling-param-model-override",
    stream: false,
    instructions: "LEAKED SAMPLING INSTRUCTION",
    conversation: "conversation_123",
    previous_response_id: "response_123",
    prompt: { id: "prompt_123" },
    store: true,
    input: [
      { role: "developer", content: "Full Pi system prompt\n\nLate extension text" },
      userItem,
    ],
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read files",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "bash",
        description: "Normal Pi bash",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout: { type: "number" },
          },
        },
      },
      {
        type: "function",
        name: "str_replace_editor",
        description: "Editor",
        parameters: { type: "object", properties: {} },
      },
    ],
    tool_choice: { type: "function", name: "read" },
    max_output_tokens: 384_000,
  };

  const rewritten = rewriteBootstrapPayload(payload, { maxOutputTokens: 2048 }) as typeof payload;

  assert.notEqual(rewritten, payload);
  assert.deepEqual(rewritten.input, [
    { role: "developer", content: MINIMAL_PERSONA },
    userItem,
  ]);
  assert.deepEqual(rewritten.tools.map((tool) => tool.name), ["bash", "str_replace_editor"]);
  assert.match(rewritten.tools[0].description, /Run commands in a bash shell/);
  assert.deepEqual(rewritten.tools[0].parameters, {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to run.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  });
  assert.equal(rewritten.instructions, MINIMAL_PERSONA);
  assert.equal(rewritten.tool_choice, "auto");
  assert.equal("conversation" in rewritten, false);
  assert.equal("previous_response_id" in rewritten, false);
  assert.equal("prompt" in rewritten, false);
  assert.equal(rewritten.model, "deepseek-v4-pro");
  assert.equal(rewritten.stream, true);
  assert.equal(rewritten.store, false);
  assert.equal(rewritten.max_output_tokens, 2048);
  assert.equal(payload.tools[0].name, "read", "the incoming payload must not be mutated");
});

test("rewrites an OpenAI Chat Completions bootstrap payload without leaking normal tools", () => {
  const payload = {
    model: "proxy/deepseek-v4-pro",
    stream: false,
    instructions: "INVALID CHAT FIELD",
    store: true,
    messages: [
      { role: "system", content: "Full Pi system prompt" },
      { role: "user", content: "Implement the task" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "bash",
          description: "Normal Pi bash",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "str_replace_editor",
          description: "Editor",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "read" } },
    max_completion_tokens: 384_000,
  };

  const rewritten = rewriteBootstrapPayload(payload, {
    api: "openai-completions",
    modelId: "proxy/deepseek-v4-pro",
    maxOutputTokens: 2048,
  }) as typeof payload;

  assert.deepEqual(rewritten.messages, [
    { role: "system", content: MINIMAL_PERSONA },
    { role: "user", content: "Implement the task" },
  ]);
  assert.deepEqual(rewritten.tools.map((tool) => tool.function.name), ["bash", "str_replace_editor"]);
  assert.match(rewritten.tools[0].function.description, /Run commands in a bash shell/);
  assert.equal(rewritten.instructions, undefined);
  assert.equal(rewritten.store, undefined);
  assert.equal(rewritten.tool_choice, "auto");
  assert.equal(rewritten.model, "proxy/deepseek-v4-pro");
  assert.equal(rewritten.stream, true);
  assert.equal(rewritten.max_completion_tokens, 2048);
});

test("rewrites an anchored continuation while preserving assistant and tool history", () => {
  const payload = {
    model: "proxy/deepseek-v4-pro",
    stream: false,
    messages: [
      { role: "system", content: "Full Pi system prompt" },
      { role: "user", content: "Implement the task" },
      { role: "assistant", content: "<think>reasoning</think>", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
    tools: [
      { type: "function", function: { name: "read", description: "Read files", parameters: {} } },
      { type: "function", function: { name: "bash", description: "Normal bash", parameters: {} } },
      { type: "function", function: { name: "str_replace_editor", description: "Editor", parameters: {} } },
    ],
    max_completion_tokens: 2048,
  };

  const rewritten = rewriteMinimalPayload(payload, {
    api: "openai-completions",
    modelId: "proxy/deepseek-v4-pro",
  }) as typeof payload;

  assert.deepEqual(rewritten.messages, [
    { role: "system", content: MINIMAL_PERSONA },
    ...payload.messages.slice(1),
  ]);
  assert.deepEqual(rewritten.tools.map((tool) => tool.function.name), ["bash", "str_replace_editor"]);
  assert.equal(rewritten.stream, true);
  assert.equal(rewritten.max_completion_tokens, 2048);
  assert.equal(payload.messages[0].content, "Full Pi system prompt");
});

test("rewrites an Anthropic Messages v1 bootstrap payload with its native schema", () => {
  const payload = {
    model: "gateway/deepseek-v4-pro",
    stream: false,
    system: [{ type: "text", text: "Full Pi system prompt" }],
    messages: [{ role: "user", content: [{ type: "text", text: "Implement the task" }] }],
    tools: [
      { name: "read", description: "Read files", input_schema: { type: "object", properties: {} } },
      { name: "bash", description: "Normal Pi bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      { name: "str_replace_editor", description: "Editor", input_schema: { type: "object", properties: {} } },
    ],
    tool_choice: { type: "tool", name: "read" },
    max_tokens: 384_000,
  };

  const rewritten = rewriteBootstrapPayload(payload, {
    api: "anthropic-messages",
    modelId: "gateway/deepseek-v4-pro",
    maxOutputTokens: 2048,
  }) as typeof payload;

  assert.deepEqual(rewritten.system, [{ type: "text", text: MINIMAL_PERSONA }]);
  assert.deepEqual(rewritten.messages, payload.messages);
  assert.deepEqual(rewritten.tools.map((tool) => tool.name), ["bash", "str_replace_editor"]);
  assert.deepEqual(rewritten.tools[0].input_schema, {
    type: "object",
    properties: { command: { type: "string", description: "The bash command to run." } },
    required: ["command"],
    additionalProperties: false,
  });
  assert.deepEqual(rewritten.tool_choice, { type: "auto" });
  assert.equal(rewritten.model, "gateway/deepseek-v4-pro");
  assert.equal(rewritten.stream, true);
  assert.equal(rewritten.max_tokens, 2048);
});

test("captures another extension's system block on either side of the anchor", () => {
  const base = "BASE PI SYSTEM PROMPT";
  const magicBlock = "\n\n<session-history>condensed history</session-history>";

  assert.equal(captureContinuationSystemPrompt({
    input: [
      { role: "system", content: `${MINIMAL_PERSONA}${magicBlock}` },
      { role: "user", content: "task" },
    ],
  }, base, "openai-responses"), `${base}${magicBlock}`);

  assert.equal(captureContinuationSystemPrompt({
    system: [{ type: "text", text: `${MINIMAL_PERSONA}${magicBlock}` }],
    messages: [{ role: "user", content: "task" }],
  }, base, "anthropic-messages"), `${base}${magicBlock}`);

  assert.equal(captureContinuationSystemPrompt({
    messages: [
      { role: "system", content: `${base}${magicBlock}` },
      { role: "user", content: "task" },
    ],
  }, base, "openai-completions"), `${base}${magicBlock}`);
});

test("captures every system and developer block before persistent replacement", () => {
  const baseline = "BASE PI SYSTEM";
  const cases = [
    {
      api: "openai-responses" as const,
      payload: {
        input: [
          { role: "system", content: MINIMAL_PERSONA },
          { role: "developer", content: "MAGIC CONTEXT" },
          { role: "developer", content: [{ type: "input_text", text: "PROJECT RULES" }] },
          { role: "user", content: "Continue" },
        ],
      },
      items: (rewritten: any) => rewritten.input,
    },
    {
      api: "openai-completions" as const,
      payload: {
        messages: [
          { role: "system", content: MINIMAL_PERSONA },
          { role: "developer", content: "MAGIC CONTEXT" },
          { role: "developer", content: "PROJECT RULES" },
          { role: "user", content: "Continue" },
        ],
      },
      items: (rewritten: any) => rewritten.messages,
    },
    {
      api: "anthropic-messages" as const,
      payload: {
        system: [
          { type: "text", text: MINIMAL_PERSONA },
          { type: "text", text: "MAGIC CONTEXT" },
          { type: "text", text: "PROJECT RULES" },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      },
      items: (rewritten: any) => rewritten.messages,
    },
  ];

  for (const { api, payload, items } of cases) {
    const context = captureContinuationSystemPrompt(payload, baseline, api);
    assert.match(context, /MAGIC CONTEXT/);
    assert.match(context, /PROJECT RULES/);
    const rewritten = core.rewritePersistentPayload(payload, { api, context });
    const wireItems = items(rewritten);
    const contextItem = wireItems.find((item: unknown) => JSON.stringify(item).includes("MAGIC CONTEXT"));
    assert.ok(contextItem, "persistent wire payload must include the aggregated context");
    assert.match(JSON.stringify(contextItem), /MAGIC CONTEXT/);
    assert.match(JSON.stringify(contextItem), /PROJECT RULES/);
  }
});

test("does not duplicate a repeated post-Minimal context suffix", () => {
  const baseline = "BASE PI SYSTEM";
  const cases = [
    {
      api: "openai-responses" as const,
      payload: {
        input: [
          { role: "system", content: `${MINIMAL_PERSONA}\n\nMAGIC CONTEXT` },
          { role: "user", content: "Continue" },
        ],
      },
    },
    {
      api: "openai-completions" as const,
      payload: {
        messages: [
          { role: "system", content: `${MINIMAL_PERSONA}\n\nMAGIC CONTEXT` },
          { role: "user", content: "Continue" },
        ],
      },
    },
    {
      api: "anthropic-messages" as const,
      payload: {
        system: [{ type: "text", text: `${MINIMAL_PERSONA}\n\nMAGIC CONTEXT` }],
        messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      },
    },
  ];

  for (const { api, payload } of cases) {
    const first = captureContinuationSystemPrompt(payload, baseline, api);
    const repeated = captureContinuationSystemPrompt(payload, first, api);
    assert.equal(first, `${baseline}\n\nMAGIC CONTEXT`);
    assert.equal(repeated, first);
  }
});

test("restores Chat Completions and Anthropic system prompts without changing messages", () => {

  const chat = restoreSystemPrompt({
    messages: [
      { role: "system", content: MINIMAL_PERSONA },
      { role: "user", content: "continue" },
    ],
  }, "BASE CHAT SYSTEM PROMPT", "openai-completions") as any;
  assert.deepEqual(chat.messages, [
    { role: "system", content: "BASE CHAT SYSTEM PROMPT" },
    { role: "user", content: "continue" },
  ]);

  const anthropic = restoreSystemPrompt({
    system: [{ type: "text", text: MINIMAL_PERSONA }],
    messages: [{ role: "user", content: "continue" }],
  }, "BASE MESSAGES SYSTEM PROMPT", "anthropic-messages") as any;
  assert.deepEqual(anthropic.system, [{ type: "text", text: "BASE MESSAGES SYSTEM PROMPT" }]);
  assert.deepEqual(anthropic.messages, [{ role: "user", content: "continue" }]);
});

test("restores the original Responses system prompt without touching the user input", () => {
  const payload = {
    instructions: "LEAKED SAMPLING INSTRUCTION",
    input: [
      { role: "system", content: MINIMAL_PERSONA },
      { role: "developer", content: "LATE EXTENSION INSTRUCTION" },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    tools: [],
  };
  const restored = restoreSystemPrompt(payload, "BASE PI SYSTEM PROMPT") as typeof payload;
  assert.equal(restored.instructions, "BASE PI SYSTEM PROMPT");
  assert.deepEqual(restored.input, [
    { role: "system", content: "BASE PI SYSTEM PROMPT" },
    { role: "developer", content: "LATE EXTENSION INSTRUCTION" },
    { role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);
  assert.deepEqual(payload.input[0], { role: "system", content: MINIMAL_PERSONA });
});
test("rejects history items injected into a bootstrap request", () => {
  assert.throws(
    () => rewriteBootstrapPayload({
      model: "deepseek-v4-pro",
      input: [
        { role: "system", content: MINIMAL_PERSONA },
        { role: "user", content: "new task" },
        { role: "assistant", content: "old answer" },
      ],
      tools: [
        { type: "function", name: "bash", description: "bash", parameters: {} },
        { type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
      ],
    }),
    /unsupported bootstrap role: assistant/,
  );
});

test("refuses a bootstrap request when the serialized anchor tool pair is incomplete", () => {
  assert.throws(
    () => rewriteBootstrapPayload({
      input: [{ role: "system", content: "normal" }],
      tools: [{ type: "function", name: "bash", description: "bash", parameters: {} }],
    }),
    /missing required bootstrap tool.*str_replace_editor/i,
  );
});
test("matches only the deepseek-v4-pro model suffix across supported APIs", () => {
  assert.equal(isTargetModel({ provider: "any-provider", id: "deepseek-v4-pro", api: "openai-responses" }), true);
  assert.equal(isTargetModel({ provider: "gateway", id: "gateway/deepseek-v4-pro", api: "openai-completions" }), true);
  assert.equal(isTargetModel({ provider: "proxy", id: "alias/deepseek-v4-pro", api: "anthropic-messages" }), true);
  assert.equal(isTargetModel({ provider: "provider-a", id: "deepseek-v4-pro", api: "openai-completions" }), true);
  assert.equal(isTargetModel({ provider: "provider-b", id: "deepseek-v4-pro", api: "openai-responses" }), true);
  assert.equal(isTargetModel({ provider: "provider-c", id: "deepseek-v4-pro", api: "anthropic-messages" }), true);
  assert.equal(isTargetModel({ provider: "provider-a", id: "deepseek-v4-pro:free", api: "openai-responses" }), false);
  assert.equal(isTargetModel({ provider: "provider-a", id: "deepseek-v4-pro-preview", api: "openai-responses" }), false);
  assert.equal(isTargetModel({ provider: "provider-a", id: "deepseek-v4-pro", api: "google-generative-ai" }), false);
  assert.equal(isTargetModel(undefined), false);
});



test("treats context-bearing entries as non-fresh but ignores settings entries", () => {
  assert.equal(hasConversation([
    { type: "model_change" },
    { type: "thinking_level_change" },
    { type: "custom", customType: "v4-anchor-state", data: { enabled: true } },
  ]), false);
  assert.equal(hasConversation([{ type: "message", message: { role: "user", content: "work" } }]), true);
  assert.equal(hasConversation([{ type: "custom_message", customType: "memory", content: "rules" }]), true);
  assert.equal(hasConversation([{ type: "compaction", summary: "old context" }]), true);
  assert.equal(hasConversation([{ type: "branch_summary", summary: "old branch" }]), true);
});

test("reads a validated baseline tool snapshot for an armed state", () => {
  assert.deepEqual(readAnchorSnapshot([
    {
      type: "custom",
      customType: "v4-anchor-state",
      data: {
        enabled: true,
        phase: "bootstrap",
        baselineTools: ["read", "bash", "edit", "write", "str_replace_editor"],
      },
    },
  ]), {
    state: { enabled: true, phase: "bootstrap" },
    baselineTools: ["read", "bash", "edit", "write", "str_replace_editor"],
  });
  assert.deepEqual(readAnchorSnapshot([
    {
      type: "custom",
      customType: "v4-anchor-state",
      data: { enabled: true, phase: "bootstrap", baselineTools: ["read", 42] },
    },
  ]), {
    state: { enabled: true, phase: "bootstrap" },
  });
});

test("validates persisted reasoning threshold state", () => {
  assert.deepEqual(readAnchorSnapshot([{
    type: "custom",
    customType: "v4-anchor-state",
    data: {
      enabled: true,
      phase: "anchored",
      minThinkingTokens: 2048,
      thinkingTokens: 1024,
    },
  }]).state, {
    enabled: true,
    phase: "anchored",
    minThinkingTokens: 2048,
    thinkingTokens: 1024,
  });

  assert.deepEqual(readAnchorSnapshot([{
    type: "custom",
    customType: "v4-anchor-state",
    data: {
      enabled: true,
      phase: "anchored",
      minThinkingTokens: -1,
      thinkingTokens: Number.POSITIVE_INFINITY,
    },
  }]).state, {
    enabled: true,
    phase: "anchored",
  });
});

test("reads the latest anchor state from branch order and falls back to off", () => {
  assert.deepEqual(readAnchorState([
    { type: "custom", customType: "v4-anchor-state", data: { enabled: true, phase: "bootstrap" } },
    { type: "custom", customType: "other", data: {} },
    { type: "custom", customType: "v4-anchor-state", data: { enabled: false, phase: "off" } },
  ]), { enabled: false, phase: "off" });
  assert.deepEqual(readAnchorState([{ type: "custom", customType: "other", data: {} }]), {
    enabled: false,
    phase: "off",
  });
});

test("rewrites persistent payloads for every supported API without filtering normal tools", () => {
  type PersistentRewrite = (payload: unknown, options: {
    api: "openai-responses" | "openai-completions" | "anthropic-messages";
    context: string;
  }) => any;
  const rewrite = (core as unknown as { rewritePersistentPayload?: PersistentRewrite }).rewritePersistentPayload;
  assert.equal(typeof rewrite, "function");
  if (!rewrite) return;

  const context = "FULL PI SYSTEM\n\n<session-history>Magic Context</session-history>";
  const responsePayload = {
    instructions: "FULL PI SYSTEM",
    previous_response_id: "response_123",
    input: [
      { role: "system", content: "FULL PI SYSTEM" },
      { role: "developer", content: "LATE EXTENSION" },
      { role: "user", content: "Continue" },
    ],
    tools: [{ type: "function", name: "ctx_search", parameters: {} }],
  };
  const responses = rewrite(responsePayload, { api: "openai-responses", context });
  assert.deepEqual(responses.input[0], { role: "system", content: MINIMAL_PERSONA });
  assert.match(JSON.stringify(responses.input[1]), /Magic Context/);
  assert.deepEqual(responses.input.at(-1), { role: "user", content: "Continue" });
  assert.equal(responses.instructions, MINIMAL_PERSONA);
  assert.equal(responses.previous_response_id, "response_123");
  assert.deepEqual(responses.tools, responsePayload.tools);
  assert.equal(JSON.stringify(responsePayload).includes(MINIMAL_PERSONA), false);

  const chatPayload = {
    messages: [
      { role: "system", content: "FULL PI SYSTEM" },
      { role: "developer", content: "LATE EXTENSION" },
      { role: "user", content: "Continue" },
    ],
    tools: [{ type: "function", function: { name: "ctx_search", parameters: {} } }],
  };
  const chat = rewrite(chatPayload, { api: "openai-completions", context });
  assert.deepEqual(chat.messages[0], { role: "system", content: MINIMAL_PERSONA });
  assert.match(JSON.stringify(chat.messages[1]), /Magic Context/);
  assert.deepEqual(chat.messages.at(-1), { role: "user", content: "Continue" });
  assert.deepEqual(chat.tools, chatPayload.tools);

  const messagesPayload = {
    system: [{ type: "text", text: "FULL PI SYSTEM" }],
    messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    tools: [{ name: "ctx_search", input_schema: {} }],
  };
  const messages = rewrite(messagesPayload, { api: "anthropic-messages", context });
  assert.deepEqual(messages.system, [{ type: "text", text: MINIMAL_PERSONA }]);
  assert.match(JSON.stringify(messages.messages[0]), /Magic Context/);
  assert.deepEqual(messages.messages.at(-1), messagesPayload.messages[0]);
  assert.deepEqual(messages.tools, messagesPayload.tools);
});
