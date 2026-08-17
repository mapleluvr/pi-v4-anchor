import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const USER_INTENT_VERSION = 2;
const USER_INTENT_FILE = "pi-v4-anchor-state.json";

type UserIntentData = {
  version: number;
  enabled: boolean;
  hold?: boolean;
  minThinkingTokens?: number;
};

export interface AnchorIntent {
  enabled: boolean;
  hold?: true;
  minThinkingTokens?: number;
}

export interface AnchorIntentStore {
  read(): AnchorIntent;
  write(intent: AnchorIntent): void;
}

export function getAnchorIntentPath(agentDir = getAgentDir()): string {
  return join(agentDir, USER_INTENT_FILE);
}

function parseUserIntent(value: unknown): AnchorIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Partial<UserIntentData>;
  if ((data.version !== 1 && data.version !== USER_INTENT_VERSION) || typeof data.enabled !== "boolean") {
    return undefined;
  }
  if (!data.enabled) return { enabled: false };
  if (data.version === 1) return { enabled: true };
  if (data.hold === true) return { enabled: true, hold: true };
  if (Number.isSafeInteger(data.minThinkingTokens) && (data.minThinkingTokens ?? 0) > 0) {
    return { enabled: true, minThinkingTokens: data.minThinkingTokens };
  }
  return { enabled: true };
}

export class FileAnchorIntentStore implements AnchorIntentStore {
  read(): AnchorIntent {
    try {
      const content = readFileSync(getAnchorIntentPath(), "utf8");
      return parseUserIntent(JSON.parse(content)) ?? { enabled: false };
    } catch {
      return { enabled: false };
    }
  }

  write(intent: AnchorIntent): void {
    const normalized = intent.enabled
      ? intent.hold
        ? { enabled: true, hold: true as const }
        : Number.isSafeInteger(intent.minThinkingTokens) && (intent.minThinkingTokens ?? 0) > 0
          ? { enabled: true, minThinkingTokens: intent.minThinkingTokens }
          : { enabled: true }
      : { enabled: false };
    const path = getAnchorIntentPath();
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ version: USER_INTENT_VERSION, ...normalized })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        renameSync(temporaryPath, path);
      } catch {
        // Node's replacement rename varies across Windows filesystems. The state is only
        // a boolean intent, so the fallback remains fail-closed if a concurrent reader wins.
        rmSync(path, { force: true });
        renameSync(temporaryPath, path);
      }
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
