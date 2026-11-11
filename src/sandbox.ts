import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import type { Env } from "./env";

export class Sandbox extends DurableObject<Env> {
  private async container() {
    const container = this.ctx.container;
    if (!container) throw new Error("Sandbox Container binding is not configured");
    if (!container.running) {
      container.start({ image: container.images.sandbox, enableInternet: false });
    }
    await container.setInactivityTimeout(300_000);
    return container;
  }

  async run(command: string) {
    const container = await this.container();
    const process = await container.exec(["sh", "-lc", command], {
      cwd: "/workspace",
      signal: AbortSignal.timeout(60_000),
    });
    // Drain both pipes while running, retaining a bounded prefix instead of output().
    const read = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return "";
      const reader = stream.getReader();
      const bytes = new Uint8Array(32_768);
      let retained = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const prefix = chunk.value.subarray(0, bytes.length - retained);
          bytes.set(prefix, retained);
          retained += prefix.length;
        }
        return new TextDecoder().decode(bytes.subarray(0, retained));
      } finally {
        reader.releaseLock();
      }
    };
    const [stdout, stderr, exitCode] = await Promise.all([read(process.stdout), read(process.stderr), process.exitCode]);
    return { stdout, stderr, exitCode };
  }

  async readFile(path: string) {
    const response = await new Files(await this.container()).readFile(path);
    // readFile is a binary Response. Bound the bytes before decoding.
    const reader = response.body?.getReader();
    if (!reader) return "";
    let size = 0;
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65_536) throw new Error("File exceeds 64 KiB; use a shell command to read a range");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel();
    }
  }
}
