const fs = require("node:fs/promises");
const { StringDecoder } = require("node:string_decoder");
const { setImmediate: yieldToRequests } = require("node:timers/promises");

const CHUNK_BYTES = 64 * 1024;
const PROBE_BYTES = 256;

function signature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

// One in-flight read per path shares the dashboard's request fan-out. Parsing
// yields between bounded chunks so a cold/replaced queue cannot monopolize the
// HTTP event loop. Keep committed newline-terminated rows separate from a tail
// that a concurrent writer may still be completing.
function createAsyncQueueReader({ parseRow, label, maxEntries = 4 }) {
  const cache = new Map();
  const pending = new Map();

  async function probe(file, position, length) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  async function load(queuePath) {
    const cached = cache.get(queuePath);
    let file;
    try {
      file = await fs.open(queuePath, "r");
      // Stat the opened file, rather than a path which can be atomically replaced
      // between stat and open. Its signature always describes the bytes we read.
      const stat = await file.stat({ bigint: true });
      const nextSignature = signature(stat);
      if (cached?.signature === nextSignature) return cached.rows;
      const identity = `${stat.dev}:${stat.ino}`;
      const size = Number(stat.size);
      let offset = 0;
      let seen = new Map();
      if (cached && cached.identity === identity && size > cached.size && cached.consumedBytes > 0) {
        const head = await probe(file, 0, cached.head.length);
        const anchor = await probe(file, cached.consumedBytes - cached.anchor.length, cached.anchor.length);
        if (head.equals(cached.head) && anchor.equals(cached.anchor)) {
          offset = cached.consumedBytes;
          seen = cached.seen;
        }
      }

      const changes = new Map();
      let malformed = 0;
      function parse(line, target) {
        if (!line.trim()) return;
        try {
          const entry = parseRow(JSON.parse(line));
          if (entry) target.set(entry.key, entry.row);
        } catch { malformed++; }
      }

      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let remainder = "";
      let position = offset;
      let consumedBytes = offset;
      while (position < size) {
        const length = Math.min(CHUNK_BYTES, size - position);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        if (!bytesRead) throw new Error("Queue truncated during read");
        const newline = buffer.lastIndexOf(0x0a, bytesRead - 1);
        if (newline >= 0) consumedBytes = position + newline + 1;
        position += bytesRead;
        remainder += decoder.write(buffer.subarray(0, bytesRead));
        let start = 0;
        let end;
        while ((end = remainder.indexOf("\n", start)) !== -1) {
          parse(remainder.slice(start, end), changes);
          start = end + 1;
        }
        remainder = remainder.slice(start);
        await yieldToRequests();
      }
      remainder += decoder.end();
      // Capture probes before committing any state: a failed read must not mutate
      // a snapshot still being used by another endpoint.
      const head = await probe(file, 0, Math.min(PROBE_BYTES, consumedBytes));
      const anchor = await probe(file, Math.max(0, consumedBytes - PROBE_BYTES), Math.min(PROBE_BYTES, consumedBytes));
      for (const [key, row] of changes) seen.set(key, row);
      const tail = new Map();
      parse(remainder, tail);
      // Legacy files without a final newline are readable, but their provisional
      // key never enters the committed map (completion may change that key).
      const rows = tail.size ? Array.from(new Map([...seen, ...tail]).values()) : Array.from(seen.values());
      cache.delete(queuePath);
      cache.set(queuePath, { signature: nextSignature, identity, size, consumedBytes, head, anchor, seen, rows });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      if (malformed) console.error(`[LocalAPI] ${label}: skipped ${malformed} malformed line(s)`);
      return rows;
    } catch (error) {
      if (error.code === "ENOENT") {
        cache.delete(queuePath);
        return [];
      }
      console.error(`[LocalAPI] ${label}: failed to read queue:`, error.message);
      return cached?.rows || [];
    } finally {
      if (file) await file.close();
    }
  }

  return function read(queuePath) {
    if (pending.has(queuePath)) return pending.get(queuePath);
    const task = load(queuePath).finally(() => pending.delete(queuePath));
    pending.set(queuePath, task);
    return task;
  };
}

module.exports = { createAsyncQueueReader };
