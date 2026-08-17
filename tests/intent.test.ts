import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileAnchorIntentStore, getAnchorIntentPath } from "../src/intent.ts";

test("migrates v1 enablement and persists v2 activation settings", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-v4-anchor-intent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(getAnchorIntentPath(), `${JSON.stringify({ version: 1, enabled: true })}\n`, "utf8");
    const store = new FileAnchorIntentStore();

    assert.deepEqual(store.read(), { enabled: true });

    store.write({ enabled: true, minThinkingTokens: 2048 });
    assert.deepEqual(JSON.parse(await readFile(getAnchorIntentPath(), "utf8")), {
      version: 2,
      enabled: true,
      minThinkingTokens: 2048,
    });
    assert.deepEqual(store.read(), { enabled: true, minThinkingTokens: 2048 });

    store.write({ enabled: true, hold: true });
    assert.deepEqual(store.read(), { enabled: true, hold: true });

    store.write({ enabled: false });
    assert.deepEqual(store.read(), { enabled: false });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
