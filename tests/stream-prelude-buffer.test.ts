import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { StreamPreludeBuffer } from "../server/stream-prelude-buffer.js";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "samapi-buffer-test-"));
  const buffer = new StreamPreludeBuffer(root);
  t.after(async () => { await buffer.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, buffer };
}

test("large preludes spill privately, replay exact bytes in order, and leave no temporary files", async (t) => {
  const { root, buffer } = await setup(t);
  const chunks = [Buffer.from("small prefix"), Buffer.from("你好 🌍".repeat(50000)), Buffer.from("suffix")];
  await buffer.append(chunks[0]);
  assert.deepEqual(await readdir(root), [], "small preludes stay in memory");
  await buffer.append(chunks[1]);
  await buffer.append(chunks[2]);
  const directories = await readdir(root);
  assert.equal(directories.length, 1);
  const directory = join(root, directories[0]);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "body"))).mode & 0o777, 0o600);
  }
  const replayed: Uint8Array[] = [];
  let chunk: Uint8Array | undefined;
  while ((chunk = await buffer.read())) replayed.push(chunk);
  assert.deepEqual(Buffer.concat(replayed), Buffer.concat(chunks));
  await buffer.dispose();
  assert.deepEqual(await readdir(root), []);
});

test("cancelling during a spill waits for disk IO and removes all buffered data", async (t) => {
  const { root, buffer } = await setup(t);
  const append = buffer.append(new Uint8Array(1024 * 1024));
  const cleanup = buffer.dispose();
  await Promise.all([append, cleanup]);
  await buffer.dispose();
  assert.deepEqual(await readdir(root), []);
  assert.equal(await buffer.read(), undefined);
  await assert.rejects(buffer.append(new Uint8Array(1)), /已关闭/);
});

test("failed disk buffering still permits cleanup", async (t) => {
  const { root } = await setup(t);
  const invalidRoot = join(root, "file");
  await writeFile(invalidRoot, "fixture");
  const buffer = new StreamPreludeBuffer(invalidRoot);
  await assert.rejects(buffer.append(new Uint8Array(1024 * 1024)), { code: "ENOTDIR" });
  await buffer.dispose();
  assert.deepEqual(await readdir(root), ["file"]);
});
