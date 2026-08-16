import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import test from "node:test";
import { EDITOR_DESCRIPTION, executeEditor } from "../src/editor.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-v4-anchor-editor-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function msysPath(nativePath: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(nativePath)) return nativePath.replaceAll(sep, "/");
  return `/${nativePath[0]!.toLowerCase()}${nativePath.slice(2).replaceAll("\\", "/")}`;
}

test("views a real file through a Git Bash path and includes line numbers", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma", "utf8");

    const result = await executeEditor(
      { command: "view", path: msysPath(file), view_range: [2, 3] },
    );

    assert.match(result, /sample\.txt/);
    assert.match(result, /2\s+beta/);
    assert.match(result, /3\s+gamma/);
    assert.doesNotMatch(result, /1\s+alpha/);
  });
});

test("replaces exactly one occurrence and rejects ambiguous edits", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "sample.txt");
    await writeFile(file, "one\ntwo\nthree", "utf8");

    const result = await executeEditor(
      { command: "str_replace", path: file, old_str: "two", new_str: "TWO" },
    );
    assert.match(result, /edited successfully/);
    assert.equal(await readFile(file, "utf8"), "one\nTWO\nthree");

    await writeFile(file, "same\nsame", "utf8");
    await assert.rejects(
      () => executeEditor(
        { command: "str_replace", path: file, old_str: "same", new_str: "different" },
      ),
      /Multiple occurrences.*lines \[1, 2\]/,
    );
    assert.equal(await readFile(file, "utf8"), "same\nsame");
  });
});

test("creates a file, inserts at a zero-based line, and refuses create overwrite", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "nested", "new.txt");
    const created = await executeEditor(
      { command: "create", path: file, file_text: "first\nlast" },
    );
    assert.match(created, /created successfully/);

    await assert.rejects(
      () => executeEditor(
        { command: "create", path: file, file_text: "overwrite" },
      ),
      /already exists/,
    );

    await executeEditor(
      { command: "insert", path: file, insert_line: 1, new_str: "middle" },
    );
    assert.equal(await readFile(file, "utf8"), "first\nmiddle\nlast");
  });
});

test("matches LF replacement text against a CRLF file and preserves CRLF", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "replace-windows.txt");
    await writeFile(file, "one\r\ntwo\r\nthree\r\n", "utf8");

    await executeEditor({
      command: "str_replace",
      path: file,
      old_str: "one\ntwo",
      new_str: "ONE\nTWO",
    });

    assert.equal(await readFile(file, "utf8"), "ONE\r\nTWO\r\nthree\r\n");
  });
});

test("preserves CRLF endings when inserting multiline text", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "windows.txt");
    await writeFile(file, "first\r\nlast\r\n", "utf8");

    await executeEditor(
      { command: "insert", path: file, insert_line: 1, new_str: "middle\nnext" },
    );

    assert.equal(await readFile(file, "utf8"), "first\r\nmiddle\r\nnext\r\nlast\r\n");
    assert.match(EDITOR_DESCRIPTION, /C:\/\.\.\..*\/c\/\.\.\..*\/mnt\/c\/\.\.\./s);
  });
});

test("does not mutate a file after an aborted queued operation resumes", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "aborted.txt");
    const controller = new AbortController();
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    const pending = executeEditor(
      { command: "create", path: file, file_text: "must not be written" },
      {
        signal: controller.signal,
        async withMutationQueue(_path, operation) {
          await queueGate;
          return operation();
        },
      },
    );
    controller.abort();
    releaseQueue();

    await assert.rejects(pending, /aborted/i);
    await assert.rejects(() => readFile(file, "utf8"), { code: "ENOENT" });
  });
});

test("lists a directory and clips oversized output", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "visible.txt"), "content", "utf8");
    await writeFile(join(dir, ".hidden.txt"), "hidden", "utf8");

    const result = await executeEditor(
      { command: "view", path: dir },
      { maxOutputChars: 20 },
    );

    assert.match(result, /response clipped/);
    assert.doesNotMatch(result, /hidden\.txt/);
    assert.equal(basename(dir).startsWith("pi-v4-anchor-editor-"), true);
  });
});
