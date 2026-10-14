const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  repairZcodeInclusiveTokenMigration,
  repairZcodeNativeUsageMigration,
} = require("../src/commands/sync");

function row(source, model, hour, total) {
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

test("native ZCode migration purges legacy rows once and preserves unrelated usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-native-repair-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const hour = "2026-06-15T09:00:00Z";
    await fs.writeFile(queuePath, [row("zcode", "GLM-5.2", hour, 12), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [row("zcode", "GLM-5.2", hour, 12), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "legacy|row": { lastTotals: { total_tokens: 12 } } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 12 } },
          [`codex|gpt-5|${hour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: { [`zcode|${hour}`]: "legacy", [`codex|${hour}`]: "keep" },
      },
      projectHourly: {
        buckets: {
          [`project|zcode|${hour}`]: { totals: { total_tokens: 12 } },
          [`project|codex|${hour}`]: { totals: { total_tokens: 20 } },
        },
      },
      migrations: {},
    };

    const changed = await repairZcodeNativeUsageMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
    });
    assert.equal(changed, true);
    const mainRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const zcodeRetractions = mainRows.filter((entry) => entry.source === "zcode");
    assert.equal(zcodeRetractions.length, 1, "cloud replay retains one zero for the removed key");
    assert.equal(zcodeRetractions[0].total_tokens, 0);
    assert.equal((await fs.readFile(projectQueuePath, "utf8")).includes('"source":"zcode"'), false);
    assert.ok(cursors.hourly.buckets[`codex|gpt-5|${hour}`]);
    assert.ok(!Object.keys(cursors.hourly.buckets).some((key) => key.startsWith("zcode|")));
    assert.ok(!Object.keys(cursors.projectHourly.buckets).some((key) => key.includes("|zcode|")));
    assert.equal(cursors.zcode, undefined);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
    assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 0);

    const changedAgain = await repairZcodeNativeUsageMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
    });
    assert.equal(changedAgain, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("inclusive-token ZCode migration retracts prior totals and resets replay once", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-inclusive-repair-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const hour = "2026-08-31T09:00:00Z";
    await fs.writeFile(queuePath, [row("zcode", "GLM-5.2", hour, 100), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [row("zcode", "GLM-5.2", hour, 100), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "legacy|row": { lastTotals: { total_tokens: 100 } } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 100 } },
          [`codex|gpt-5|${hour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: { [`zcode|${hour}`]: "inflated", [`codex|${hour}`]: "keep" },
      },
      projectHourly: {
        buckets: {
          [`project|zcode|${hour}`]: { totals: { total_tokens: 100 } },
          [`project|codex|${hour}`]: { totals: { total_tokens: 20 } },
        },
      },
      migrations: {},
    };

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
    }), true);
    const replayRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(replayRows.filter((entry) => entry.source === "zcode").length, 1);
    assert.equal(replayRows.find((entry) => entry.source === "zcode").total_tokens, 0);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).note,
      "reset_after_zcode_inclusive_token_repair_2026_09");
    assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).note,
      "reset_after_zcode_inclusive_token_repair_2026_09");
    assert.equal(cursors.zcode, undefined);

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
    }), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("ZCode usage repair clears the sandbox namespaces so their buckets can replay", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-sandbox-repair-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const hour = "2026-10-02T09:00:00Z";
    await fs.writeFile(queuePath, `${row("zcode", "deepseek/deepseek-v4.1-flash", hour, 1000)}\n`);
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 10 }));
    const cursors = {
      zcode: { messages: { "host|row": { lastTotals: { total_tokens: 20 } } } },
      // Sandbox rows queue under `zcode|` buckets, so the wipe below already discards their contribution.
      zcodeSandbox: { messages: { "sandbox|row": { lastTotals: { total_tokens: 1000 } } } },
      zcodeSandboxDbStats: { "/p/.lazyzcode/review/a.a1.r1/home/.zcode/cli/db/db.sqlite": "4096:1759363200000" },
      hourly: {
        buckets: { [`zcode|deepseek/deepseek-v4.1-flash|${hour}`]: { totals: { total_tokens: 1000 } } },
        groupQueued: {},
      },
      migrations: {},
    };

    assert.equal(await repairZcodeInclusiveTokenMigration({ cursors, queuePath, queueStatePath }), true);
    assert.equal(cursors.zcode, undefined);
    assert.equal("zcodeSandbox" in cursors, false,
      "sandbox message index must reset too, or replayed rows dedupe against the surviving index");
    assert.equal("zcodeSandboxDbStats" in cursors, false,
      "the size+mtime map must reset too, or every unchanged sub-ledger skips forever and the cleared bucket never returns");
    assert.deepEqual(Object.keys(cursors.hourly.buckets), [], "zcode buckets dropped with the repair");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
