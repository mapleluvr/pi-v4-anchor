import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAGIC_TOOL_NAMES = ["ctx_search", "ctx_memory", "ctx_note", "ctx_expand", "ctx_reduce", "todowrite"] as const;

const TARGET_MODEL = {
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro SDK test model",
  api: "openai-responses",
  provider: "AnyGateway",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_000,
  maxTokens: 384_000,
} as const;

test("loads through the Pi SDK and executes on/off without a model request", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-v4-anchor-sdk-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir,
      additionalExtensionPaths: [join(PROJECT_ROOT, "index.ts")],
      extensionFactories: [{
        name: "magic-context-tool-surface-fixture",
        hidden: true,
        factory(pi) {
          for (const name of MAGIC_TOOL_NAMES) {
            pi.registerTool({
              name,
              label: name,
              description: `Magic Context fixture: ${name}`,
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "fixture" }], details: {} };
              },
            });
          }
        },
      }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "BASE PI SYSTEM PROMPT",
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: PROJECT_ROOT,
      agentDir,
      model: TARGET_MODEL as any,
      thinkingLevel: "max",
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(PROJECT_ROOT),
    });
    session = created.session;
    await session.bindExtensions({
      mode: "print",
      onError(error) {
        throw new Error(`${error.event}: ${error.error}`);
      },
    });

    assert.deepEqual(created.extensionsResult.errors, []);
    assert.equal(created.extensionsResult.extensions.length, 2);
    assert.ok(session.getToolDefinition("str_replace_editor"));
    const baselineTools = ["read", "bash", "edit", "write", ...MAGIC_TOOL_NAMES];
    assert.deepEqual(session.getActiveToolNames(), baselineTools);

    await session.prompt("/v4-anchor status");
    await session.prompt("/v4-anchor on");
    assert.deepEqual(session.getActiveToolNames(), [...baselineTools, "str_replace_editor"]);
    assert.deepEqual((session.sessionManager.getBranch().at(-1) as any)?.data?.baselineTools, baselineTools);

    await session.reload();
    assert.deepEqual(
      session.sessionManager.getBranch()
        .filter((entry: any) => entry.customType === "v4-anchor-state")
        .map((entry: any) => entry.data),
      [{
        enabled: true,
        phase: "bootstrap",
        baselineTools,
      }],
    );
    assert.deepEqual(session.getAllTools().map((tool) => tool.name).sort(),
      ["bash", "ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "ctx_search", "edit", "find", "grep", "ls", "read", "str_replace_editor", "todowrite", "write"]);
    assert.deepEqual(session.getActiveToolNames(), [...baselineTools, "str_replace_editor"]);

    await session.prompt("/v4-anchor off");
    assert.deepEqual(session.getActiveToolNames(), baselineTools);
  } finally {
    session?.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
