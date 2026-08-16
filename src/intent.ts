import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const USER_INTENT_VERSION = 1;
const USER_INTENT_FILE = "pi-v4-anchor-state.json";

type UserIntentData = {
  version: number;
  enabled: boolean;
};

export interface AnchorIntentStore {
  read(): boolean;
  write(enabled: boolean): void;
}

export function getAnchorIntentPath(agentDir = getAgentDir()): string {
  return join(agentDir, USER_INTENT_FILE);
}

function parseUserIntent(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Partial<UserIntentData>;
  return data.version === USER_INTENT_VERSION && typeof data.enabled === "boolean"
    ? data.enabled
    : undefined;
}

export class FileAnchorIntentStore implements AnchorIntentStore {
  read(): boolean {
    try {
      const content = readFileSync(getAnchorIntentPath(), "utf8");
      const enabled = parseUserIntent(JSON.parse(content));
      return enabled ?? false;
    } catch {
      return false;
    }
  }

  write(enabled: boolean): void {
    const path = getAnchorIntentPath();
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ version: USER_INTENT_VERSION, enabled })}\n`, {
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
