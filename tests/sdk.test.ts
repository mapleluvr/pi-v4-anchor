import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("shares global enablement across independent Pi SDK sessions and restores independently", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-v4-anchor-sdk-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let child: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });

    function createResourceLoader(): DefaultResourceLoader {
      return new DefaultResourceLoader({
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
    }

    async function createSdkSession(resourceLoader: DefaultResourceLoader) {
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
      await created.session.bindExtensions({
        mode: "print",
        onError(error) {
          throw new Error(`${error.event}: ${error.error}`);
        },
      });
      assert.deepEqual(created.extensionsResult.errors, []);
      assert.equal(created.extensionsResult.extensions.length, 2);
      return created.session;
    }

    const parentResourceLoader = createResourceLoader();
    session = await createSdkSession(parentResourceLoader);
    assert.ok(session.getToolDefinition("str_replace_editor"));
    const baselineTools = ["read", "bash", "edit", "write", ...MAGIC_TOOL_NAMES];
    assert.deepEqual(session.getActiveToolNames(), baselineTools);

    await session.prompt("/v4-anchor status");
    await session.prompt("/v4-anchor on");
    assert.deepEqual(session.getActiveToolNames(), [...baselineTools, "str_replace_editor"]);
    assert.deepEqual((session.sessionManager.getBranch().at(-1) as any)?.data?.baselineTools, baselineTools);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "pi-v4-anchor-state.json"), "utf8")), {
      version: 1,
      enabled: true,
    });

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
    assert.deepEqual(
      session.getAllTools().map((tool) => tool.name).sort(),
      ["bash", "ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "ctx_search", "edit", "find", "grep", "ls", "read", "str_replace_editor", "todowrite", "write"],
    );
    assert.deepEqual(session.getActiveToolNames(), [...baselineTools, "str_replace_editor"]);

    const childResourceLoader = createResourceLoader();
    child = await createSdkSession(childResourceLoader);
    assert.deepEqual(child.getActiveToolNames(), [...baselineTools, "str_replace_editor"]);

    await session.prompt("/v4-anchor off");
    assert.deepEqual(session.getActiveToolNames(), baselineTools);
    await child.reload();
    assert.deepEqual(child.getActiveToolNames(), baselineTools);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "pi-v4-anchor-state.json"), "utf8")), {
      version: 1,
      enabled: false,
    });
  } finally {
    child?.dispose();
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
