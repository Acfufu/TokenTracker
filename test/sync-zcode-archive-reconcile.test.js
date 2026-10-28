const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { runSql } = require("./helpers/sqlite-write");
const {
  repairZcodeArchiveReconcile,
  ZCODE_ARCHIVE_RECONCILE_KEY,
} = require("../src/commands/sync");

const HOUR = "2026-09-20T19:00:00.000Z";
const STARTED_AT = Date.parse("2026-09-20T19:10:00Z");
const SESSION = "sess1";

function usageRow(source, model, hour, total) {
  return JSON.stringify({
    hour_start: hour,
    source,
    model,
    input_tokens: total,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    conversation_count: 1,
  });
}

async function createUsageDb(dbPath, rows) {
  await fs.rm(dbPath, { force: true });
  runSql(dbPath, `
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      model_id TEXT,
      started_at INTEGER,
      status TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER
    );
  `);
  for (const r of rows) {
    runSql(dbPath, `INSERT INTO model_usage VALUES (${r.map((v) =>
      typeof v === "string" ? `'${v}'` : v).join(", ")});`);
  }
}

// [id, model, input, output, startedAt] — status completed, session sess1.
function usage(id, model, input, output, startedAt = STARTED_AT) {
  return [id, SESSION, model, startedAt, "completed", input, output, 0, 0, 0];
}

function countedCursor(ids) {
  return { messages: Object.fromEntries(ids.map((id) => [`${SESSION}|${id}`, {}])) };
}

test("archive reconcile raises buckets toward max(cur, queue, union) and resets replay", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-reconcile-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const archiveDb = path.join(tmp, "archive.sqlite");
    const throttlePath = path.join(tmp, "upload.throttle.json");
    await fs.writeFile(queuePath, usageRow("zcode", "GLM-5.2", HOUR, 100) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 55 }));
    await fs.writeFile(throttlePath, "{}");
    await createUsageDb(archiveDb, [usage("a1", "GLM-5.2", 120, 80)]); // src total 200
    const cursors = {
      zcode: countedCursor(["a1"]),
      hourly: { buckets: { [`zcode|GLM-5.2|${HOUR}`]: { totals: { total_tokens: 100 } } } },
      migrations: {},
    };

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath,
      archivePath: archiveDb, throttlePath, minSourceRows: 1,
    }), true);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.total_tokens, 200);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.input_tokens, 120);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.output_tokens, 80);
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter((entry) => entry.source === "zcode").length, 2, "original + one correction");
    assert.equal(rows.at(-1).total_tokens, 200);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).note,
      "reset_after_zcode_archive_reconcile_2026_10");
    await fs.access(throttlePath).then(() => assert.fail("throttle must be cleared"), () => {});
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].bucketsRaised, 1);

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath, archivePath: archiveDb,
    }), false, "one-shot");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("archive reconcile ignores rows the parser has not counted yet", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-reconcile-uncounted-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const archiveDb = path.join(tmp, "archive.sqlite");
    const freshHour = new Date(Date.now() - 60 * 60 * 1000 - (Date.now() % 1_800_000)).toISOString();
    const freshStarted = Date.now() - 60 * 60 * 1000;
    await fs.writeFile(queuePath, usageRow("zcode", "GLM-5.2", freshHour, 100) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 55 }));
    await createUsageDb(archiveDb, [usage("future-1", "GLM-5.2", 500, 500, freshStarted)]);
    const cursors = {
      zcode: countedCursor([]), // parser never saw future-1
      hourly: { buckets: { [`zcode|GLM-5.2|${freshHour}`]: { totals: { total_tokens: 100 } } } },
      migrations: {},
    };

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath,
      archivePath: archiveDb, minSourceRows: 0,
    }), false, "no counted rows => nothing to raise");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${freshHour}`].totals.total_tokens, 100,
      "uncounted rows must not drive a raise — the parser owns them");
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].bucketsRaised, 0);
    assert.equal((await fs.readFile(queuePath, "utf8")).includes("600"), false);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 55);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("archive reconcile skips without env/archive and stays retryable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-reconcile-skip-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const archiveDb = path.join(tmp, "archive.sqlite");
    await fs.writeFile(queuePath, usageRow("zcode", "GLM-5.2", HOUR, 100) + "\n");
    const cursors = {
      zcode: countedCursor(["a1"]),
      hourly: { buckets: {} },
      migrations: {},
    };

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath, archivePath: "",
    }), false);
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].skipped, true);
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].reason, "zcode_archive_env_not_set");

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath, archivePath: path.join(tmp, "missing.sqlite"),
    }), false);
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].reason, "zcode_archive_missing");

    // Retries once the archive exists.
    await createUsageDb(archiveDb, [usage("a1", "GLM-5.2", 30, 20)]);
    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath, archivePath: archiveDb, minSourceRows: 1,
    }), true);
    // max(queue last-wins 100, source 50) = 100.
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.total_tokens, 100);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("archive reconcile is case-preserving and fills buckets from queue last-wins", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-reconcile-case-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const archiveDb = path.join(tmp, "archive.sqlite");
    await fs.writeFile(queuePath, [
      usageRow("zcode", "GLM-5.2", HOUR, 300),
      usageRow("codex", "gpt-5", HOUR, 20),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 7 }));
    await createUsageDb(archiveDb, [
      usage("a1", "GLM-5.2", 30, 20), // matches the queue key, but 50 < 300
      usage("a2", "glm-x", 5, 5),     // no queue row: parser's channel, not ours
      usage("a3", "GLM-X", 6, 6),
    ]);
    const cursors = {
      zcode: countedCursor(["a1", "a2", "a3"]),
      hourly: { buckets: {} },
      migrations: {},
    };

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath, archivePath: archiveDb, minSourceRows: 1,
    }), true);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.total_tokens, 300,
      "bucket filled from queue last-wins");
    assert.equal(Object.keys(cursors.hourly.buckets).length, 1,
      "no parser-unowned buckets and no case-merged keys");
    const rowsAfter = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rowsAfter.length, 2, "queue untouched when nothing beats last-wins");
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 7);
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].bucketsAdded, 1);
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].queueRowsAppended, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("archive reconcile settles old rows by horizon and leaves fresh rows to the parser", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-reconcile-horizon-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const archiveDb = path.join(tmp, "archive.sqlite");
    const halfHourFloor = (ms) => new Date(ms - (ms % 1_800_000)).toISOString();
    const oldHour = halfHourFloor(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const freshHour = halfHourFloor(Date.now() - 60 * 60 * 1000);
    await fs.writeFile(queuePath, [
      usageRow("zcode", "GLM-5.2", oldHour, 100),
      usageRow("zcode", "GLM-5.2", freshHour, 100),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 30 }));
    await createUsageDb(archiveDb, [
      usage("old-1", "GLM-5.2", 600, 400, Date.parse(oldHour) + 60_000),  // 1000, cursor key lost
      usage("fresh-1", "GLM-5.2", 800, 800, Date.parse(freshHour) + 60_000), // 1600, uncounted
    ]);
    const cursors = {
      zcode: countedCursor([]), // dedup index empty — both rows unknown to it
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 100 } },
          [`zcode|GLM-5.2|${freshHour}`]: { totals: { total_tokens: 100 } },
        },
      },
      migrations: {},
    };

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath,
      archivePath: archiveDb, minSourceRows: 1,
    }), true);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`].totals.total_tokens, 1000,
      "rows past the 48h horizon are settled history and raise");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${freshHour}`].totals.total_tokens, 100,
      "fresh uncounted rows stay the parser's job");
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter((entry) => entry.source === "zcode").length, 3);
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].bucketsRaised, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("archive reconcile prefers the live copy of a deduped id", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-reconcile-dedup-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const liveDb = path.join(tmp, "live.sqlite");
    const archiveDb = path.join(tmp, "archive.sqlite");
    await fs.writeFile(queuePath, usageRow("zcode", "GLM-5.2", HOUR, 100) + "\n");
    await createUsageDb(liveDb, [usage("x1", "GLM-5.2", 60, 40)]);       // total 100
    await createUsageDb(archiveDb, [usage("x1", "GLM-5.2", 599, 400)]);  // same id, total 999
    const cursors = {
      zcode: countedCursor(["x1"]),
      hourly: { buckets: { [`zcode|GLM-5.2|${HOUR}`]: { totals: { total_tokens: 100 } } } },
      migrations: {},
    };

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath,
      dbPaths: [liveDb], archivePath: archiveDb, minSourceRows: 1,
    }), false, "live copy wins the id, no raise beyond it");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.total_tokens, 100);
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].sourceRows, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("archive reconcile refuses a degenerate source read and stays retryable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-reconcile-small-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const archiveDb = path.join(tmp, "archive.sqlite");
    await fs.writeFile(queuePath, usageRow("zcode", "GLM-5.2", HOUR, 100) + "\n");
    await createUsageDb(archiveDb, [usage("a1", "GLM-5.2", 120, 80)]);
    const cursors = {
      zcode: countedCursor(["a1"]),
      hourly: { buckets: {} },
      migrations: {},
    };

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath, archivePath: archiveDb,
    }), false, "default 1000-row tripwire");
    assert.equal(cursors.migrations[ZCODE_ARCHIVE_RECONCILE_KEY].reason, "zcode_source_too_small");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`], undefined);

    assert.equal(await repairZcodeArchiveReconcile({
      cursors, queuePath, queueStatePath, archivePath: archiveDb, minSourceRows: 1,
    }), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

const {
  repairZcodeReconcileDoubling,
  ZCODE_RECONCILE_DOUBLING_KEY,
} = require("../src/commands/sync");

test("reconcile doubling fix snaps exact doubles back per column", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-doubling-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const bakPath = path.join(tmp, "queue.jsonl.bak.2026-10-28T01-39-03-002Z");
    const archiveDb = path.join(tmp, "archive.sqlite");
    // bak: pre-reconcile value 100. live: pure double 200 and raise+double 400.
    await fs.writeFile(bakPath, [
      usageRow("zcode", "GLM-5.2", HOUR, 100),
      usageRow("zcode", "GLM-5.3", HOUR, 100),
    ].join("\n") + "\n");
    await fs.writeFile(queuePath, [
      usageRow("zcode", "GLM-5.2", HOUR, 200),
      usageRow("zcode", "GLM-5.3", HOUR, 400),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 999 }));
    await createUsageDb(archiveDb, [usage("a1", "GLM-5.3", 180, 120)]); // src 300
    const cursors = {
      zcode: countedCursor(["a1"]),
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${HOUR}`]: { totals: { total_tokens: 200, input_tokens: 200 } },
          [`zcode|GLM-5.3|${HOUR}`]: { totals: { total_tokens: 400, input_tokens: 400 } },
        },
      },
      migrations: {
        [ZCODE_ARCHIVE_RECONCILE_KEY]: { appliedAt: "2026-10-28T01:39:03.007Z" },
      },
    };

    assert.equal(await repairZcodeReconcileDoubling({
      cursors, queuePath, queueStatePath,
      dbPaths: [], archivePath: archiveDb, backupPath: bakPath,
    }), true);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.total_tokens, 100,
      "pure double snaps to the bak value");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.3|${HOUR}`].totals.total_tokens, 300,
      "raise-then-double snaps to the source value");
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const byModel = new Map(rows.filter((entry) => entry.source === "zcode").map((entry) => [entry.model, entry.total_tokens]));
    assert.equal(byModel.get("GLM-5.2"), 100);
    assert.equal(byModel.get("GLM-5.3"), 300);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).note,
      "reset_after_zcode_reconcile_doubling_2026_10");
    assert.equal(cursors.migrations[ZCODE_RECONCILE_DOUBLING_KEY].bucketsFixed, 2);

    assert.equal(await repairZcodeReconcileDoubling({
      cursors, queuePath, queueStatePath, backupPath: bakPath,
    }), false, "one-shot");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("reconcile doubling fix leaves ordinary growth and unapplied reconcile alone", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-doubling-plain-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const bakPath = path.join(tmp, "queue.jsonl.bak.2026-10-28T01-39-03-002Z");
    await fs.writeFile(bakPath, usageRow("zcode", "GLM-5.2", HOUR, 100) + "\n");
    await fs.writeFile(queuePath, usageRow("zcode", "GLM-5.2", HOUR, 250) + "\n");
    const cursorsA = { hourly: { buckets: {} }, migrations: {} };
    assert.equal(await repairZcodeReconcileDoubling({
      cursors: cursorsA, queuePath, queueStatePath, backupPath: bakPath,
    }), false);
    assert.equal(cursorsA.migrations[ZCODE_RECONCILE_DOUBLING_KEY].reason, "reconcile_not_applied");

    const cursorsB = {
      zcode: countedCursor([]),
      hourly: { buckets: { [`zcode|GLM-5.2|${HOUR}`]: { totals: { total_tokens: 250 } } } },
      migrations: { [ZCODE_ARCHIVE_RECONCILE_KEY]: { appliedAt: "2026-10-28T01:39:03.007Z" } },
    };
    const queueBefore = await fs.readFile(queuePath, "utf8");
    assert.equal(await repairZcodeReconcileDoubling({
      cursors: cursorsB, queuePath, queueStatePath, backupPath: bakPath,
    }), false, "growth without the doubling signature is untouched");
    assert.equal(cursorsB.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.total_tokens, 250);
    assert.equal(await fs.readFile(queuePath, "utf8"), queueBefore);
    await fs.access(queueStatePath).then(
      () => assert.fail("offset must not be reset"),
      (error) => assert.equal(error.code, "ENOENT"),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("reconcile doubling fix snaps settled hours to max(src, bak) unconditionally", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-doubling-floor-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const bakPath = path.join(tmp, "queue.jsonl.bak.2026-10-28T01-39-03-002Z");
    const archiveDb = path.join(tmp, "archive.sqlite");
    await fs.writeFile(bakPath, [
      usageRow("zcode", "GLM-5.2", HOUR, 100),
      usageRow("zcode", "GLM-5.3", HOUR, 100),
    ].join("\n") + "\n");
    await fs.writeFile(queuePath, [
      usageRow("zcode", "GLM-5.2", HOUR, 250),
      usageRow("zcode", "GLM-5.3", HOUR, 999),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 42 }));
    await createUsageDb(archiveDb, [usage("a1", "GLM-5.3", 180, 120)]); // src 300
    const cursors = {
      zcode: countedCursor([]),
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${HOUR}`]: { totals: { total_tokens: 250 } },
          [`zcode|GLM-5.3|${HOUR}`]: { totals: { total_tokens: 999 } },
        },
      },
      migrations: { [ZCODE_ARCHIVE_RECONCILE_KEY]: { appliedAt: "2026-10-28T01:39:03.007Z" } },
    };

    assert.equal(await repairZcodeReconcileDoubling({
      cursors, queuePath, queueStatePath,
      archivePath: archiveDb, backupPath: bakPath,
      rebuildFloorMs: Date.parse(HOUR) + 60_000,
    }), true);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${HOUR}`].totals.total_tokens, 100,
      "settled hour with no source snaps to the bak value");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.3|${HOUR}`].totals.total_tokens, 300,
      "settled hour snaps to the archive source when it dominates");
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter((entry) => entry.source === "zcode").length, 4);
    assert.equal(cursors.migrations[ZCODE_RECONCILE_DOUBLING_KEY].bucketsFixed, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
