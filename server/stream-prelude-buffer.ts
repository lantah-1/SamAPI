import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEMORY_BYTES = 256 * 1024;
const REPLAY_BYTES = 64 * 1024;
const MAX_PRELUDE_BYTES = 256 * 1024 * 1024;

/** Preserve wire bytes without letting buffer size commit a response to the client. */
export class StreamPreludeBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private offset = 0;
  private file?: FileHandle;
  private directory?: string;
  private operation: Promise<unknown> = Promise.resolve();
  private disposal?: Promise<void>;

  constructor(private readonly root = tmpdir()) {}

  // Cancellation can race a disk read/write. Close and remove only after it has settled.
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operation.then(operation);
    this.operation = pending.catch(() => {});
    return pending;
  }

  append(chunk: Uint8Array): Promise<void> {
    if (this.disposal) return Promise.reject(new Error("上游前置缓冲已关闭"));
    return this.run(async () => {
      if (this.size + chunk.byteLength > MAX_PRELUDE_BYTES) throw new Error("上游在返回内容前发送了过多前置数据");
      if (!this.file && this.size + chunk.byteLength <= MEMORY_BYTES) {
        this.chunks.push(chunk);
      } else {
        if (!this.file) {
          this.directory = await mkdtemp(join(this.root, "samapi-prelude-"));
          this.file = await open(join(this.directory, "body"), "wx+", 0o600);
          for (const buffered of this.chunks) await this.write(buffered);
          this.chunks = [];
        }
        await this.write(chunk);
      }
      this.size += chunk.byteLength;
    });
  }

  private async write(chunk: Uint8Array) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.file!.write(chunk, offset, chunk.byteLength - offset);
      if (!bytesWritten) throw new Error("无法写入上游前置缓冲");
      offset += bytesWritten;
    }
  }

  read(): Promise<Uint8Array | undefined> {
    if (this.disposal) return Promise.resolve(undefined);
    return this.run(async () => {
      if (!this.file) return this.chunks.shift();
      if (this.offset === this.size) return undefined;
      const chunk = new Uint8Array(Math.min(REPLAY_BYTES, this.size - this.offset));
      const { bytesRead } = await this.file.read(chunk, 0, chunk.byteLength, this.offset);
      if (!bytesRead) throw new Error("无法读取上游前置缓冲");
      this.offset += bytesRead;
      return chunk.subarray(0, bytesRead);
    });
  }

  dispose(): Promise<void> {
    return this.disposal ??= this.run(async () => {
      this.chunks = [];
      try { await this.file?.close(); }
      finally {
        this.file = undefined;
        if (this.directory) await rm(this.directory, { recursive: true, force: true });
        this.directory = undefined;
      }
    });
  }
}
