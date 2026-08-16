import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeEditorPath, type SupportedPlatform } from "./core.ts";

export type EditorCommand = "view" | "create" | "str_replace" | "insert";

export interface EditorArgs {
  command: EditorCommand;
  path: string;
  file_text?: string;
  insert_line?: number;
  new_str?: string;
  old_str?: string;
  view_range?: number[];
}

export interface EditorOptions {
  platform?: SupportedPlatform;
  maxOutputChars?: number;
  signal?: AbortSignal;
  withMutationQueue?: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
}

export const EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
* On Windows, \`path\` may use \`C:/...\`, \`C:\\\\...\`, Git Bash \`/c/...\`, or WSL \`/mnt/c/...\``;

const EDITOR_TRUNCATED_MESSAGE =
  "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function awaitFilesystem<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

function required(value: string | undefined, name: string, command: EditorCommand, allowEmpty = true): string {
  if (value === undefined) throw new Error(`Parameter \`${name}\` is required for command: ${command}`);
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Parameter \`${name}\` is empty for command: ${command}`);
  }
  return value;
}

function truncate(content: string, maxOutputChars: number): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + EDITOR_TRUNCATED_MESSAGE;
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    return line;
  });
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const match = content.indexOf(search, offset);
    if (match < 0) return offsets;
    offsets.push(match);
    offset = match + search.length;
  }
}

function textLines(content: string): string[] {
  return content.split(/\r\n|\n/);
}

function newlineStyle(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function convertNewlines(content: string, newline: "\r\n" | "\n"): string {
  return content.replace(/\r\n|\n/g, newline);
}

function formatFileView(
  path: string,
  content: string,
  maxOutputChars: number,
  viewRange?: number[],
): string {
  const allLines = textLines(content);
  let lines = allLines;
  let firstLine = 1;
  let lastLine: number | undefined;

  if (viewRange !== undefined) {
    if (
      viewRange.length !== 2
      || !viewRange.every(Number.isInteger)
      || viewRange[0] === undefined
      || viewRange[1] === undefined
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    firstLine = viewRange[0];
    lastLine = viewRange[1];
    if (firstLine < 1 || firstLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${firstLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      );
    }
    if (lastLine !== -1 && lastLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${lastLine}\` should be smaller than the number of lines of the file: \`${allLines.length}\``,
      );
    }
    if (lastLine !== -1 && lastLine < firstLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${lastLine}\` should be larger or equal than its first \`${firstLine}\``,
      );
    }
    lines = lastLine === -1
      ? allLines.slice(firstLine - 1)
      : allLines.slice(firstLine - 1, lastLine);
  }

  const numbered = lines
    .map((line, index) => `${String(firstLine + index).padStart(6, " ")}  ${line}`)
    .join("\n");
  const rangeText = viewRange ? ` with view_range=[${firstLine}, ${lastLine}]` : "";
  return truncate(
    `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)${rangeText}:\n${numbered}\n`,
    maxOutputChars,
  );
}

async function listDirectory(path: string, maxOutputChars: number, signal?: AbortSignal): Promise<string> {
  async function visit(dir: string, depth: number): Promise<string[]> {
    const rows: string[] = [];
    const entries = await awaitFilesystem(signal, () => readdir(dir, { withFileTypes: true }));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") {
        continue;
      }
      const entryPath = join(dir, entry.name);
      rows.push(`${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"}\t${entryPath}`);
      if (entry.isDirectory() && depth < 2) rows.push(...await visit(entryPath, depth + 1));
    }
    return rows;
  }

  const rows = [`d\t${path}`, ...(await visit(path, 1))];
  rows.sort((left, right) => left.slice(left.indexOf("\t") + 1).localeCompare(right.slice(right.indexOf("\t") + 1)));
  const listing = truncate(rows.join("\n") + "\n", maxOutputChars);
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

async function existingPath(path: string, command: EditorCommand, signal?: AbortSignal) {
  try {
    const info = await awaitFilesystem(signal, () => stat(path));
    if (info.isDirectory() && command !== "view") {
      throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
    }
    return info;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof Error && error.message.includes("is a directory")) throw error;
    throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
  }
}

async function executeEditorCommand(
  args: EditorArgs,
  path: string,
  maxOutputChars: number,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  switch (args.command) {
    case "view": {
      const info = await existingPath(path, "view", signal);
      if (info.isDirectory()) return listDirectory(path, maxOutputChars, signal);
      if (!info.isFile()) throw new Error(`cannot view "${path}": not a regular file or directory`);
      const content = await awaitFilesystem(signal, () => readFile(path, "utf8"));
      return formatFileView(path, content, maxOutputChars, args.view_range);
    }
    case "create": {
      const fileText = required(args.file_text, "file_text", "create");
      await awaitFilesystem(signal, () => mkdir(dirname(path), { recursive: true }));
      try {
        await awaitFilesystem(signal, () => writeFile(path, fileText, { encoding: "utf8", flag: "wx" }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
        }
        throw error;
      }
      return `New file created successfully at: ${path}`;
    }
    case "str_replace": {
      const oldValue = required(args.old_str, "old_str", "str_replace", false);
      const newValue = args.new_str ?? "";
      const info = await existingPath(path, "str_replace", signal);
      if (!info.isFile()) throw new Error(`cannot edit "${path}": not a regular file`);
      const before = await awaitFilesystem(signal, () => readFile(path, "utf8"));
      const newline = newlineStyle(before);
      const searchValue = convertNewlines(oldValue, newline);
      const replacementValue = convertNewlines(newValue, newline);
      const offsets = matchOffsets(before, searchValue);
      if (offsets.length === 0) {
        throw new Error(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${path}.`);
      }
      if (offsets.length > 1) {
        const lines = lineNumbersAt(before, offsets);
        throw new Error(
          `No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
        );
      }
      const offset = offsets[0]!;
      await awaitFilesystem(signal, () => writeFile(
        path,
        before.slice(0, offset) + replacementValue + before.slice(offset + searchValue.length),
        "utf8",
      ));
      return `The file ${path} has been edited successfully.`;
    }
    case "insert": {
      if (args.insert_line === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
      const value = required(args.new_str, "new_str", "insert");
      const info = await existingPath(path, "insert", signal);
      if (!info.isFile()) throw new Error(`cannot insert into "${path}": not a regular file`);
      const before = await awaitFilesystem(signal, () => readFile(path, "utf8"));
      const newline = newlineStyle(before);
      const lines = textLines(before);
      if (!Number.isInteger(args.insert_line) || args.insert_line < 0 || args.insert_line > lines.length) {
        throw new Error(
          `Invalid \`insert_line\` parameter: ${args.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`,
        );
      }
      const after = [
        ...lines.slice(0, args.insert_line),
        ...textLines(value),
        ...lines.slice(args.insert_line),
      ].join(newline);
      await awaitFilesystem(signal, () => writeFile(path, after, "utf8"));
      return `The file ${path} has been edited successfully.`;
    }
  }
}

export async function executeEditor(args: EditorArgs, options: EditorOptions = {}): Promise<string> {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars <= 0) {
    throw new Error("maxOutputChars must be a positive safe integer");
  }
  const path = normalizeEditorPath(args.path, options.platform);
  const operation = () => executeEditorCommand(args, path, maxOutputChars, options.signal);
  throwIfAborted(options.signal);
  if (args.command === "view") return operation();
  return (options.withMutationQueue ?? (async <T>(_path: string, fn: () => Promise<T>) => fn()))(path, operation);
}
