// lzy sandbox sub-ledger discovery + ingestion tests (2026-10-02 commandcode invisible-burn case backfill surface).
// Judgment surface: discoverZcodeSandboxDbs uses the host-ledger session table project directories as roots, walking only the
// .lazyzcode subtree to collect home/.zcode/cli/db/db.sqlite (prune vendored directories, skip empty-schema dbs);
// ingestion goes through the real parseOpencodeDbIncremental (cursorKey "zcodeSandbox" isolated namespace) → queue
// record materializes and second pass has no duplicates.
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { discoverZcodeSandboxDbs, readZcodeDbMessages, parseOpencodeDbIncremental, resolveZcodeInstallPaths } = require("../src/lib/rollout");

const HAS_SQLITE3 = spawnSync("sqlite3", ["--version"], { timeout: 5_000 }).status === 0;
const sql = (db, statement) => spawnSync("sqlite3", [db, statement], { encoding: "utf8", timeout: 10_000 });

const MU_SCHEMA =
  "CREATE TABLE model_usage (" +
  "id TEXT PRIMARY KEY, logical_request_id TEXT, attempt_index INTEGER, session_id TEXT, provider_id TEXT, " +
  "model_id TEXT, status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, " +
  "reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER);" +
  "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);";

async function makeSandboxDb(dir) {
  const dbDir = path.join(dir, "home", ".zcode", "cli", "db");
  await fs.mkdir(dbDir, { recursive: true });
  const db = path.join(dbDir, "db.sqlite");
  const r = sql(
    db,
    `${MU_SCHEMA} ` +
      "INSERT INTO session VALUES ('sess-sbx', '" + dir.replace(/'/g, "''") + "');" +
      "INSERT INTO model_usage VALUES ('mu-1', 'lr-1', 0, 'sess-sbx', 'new-provider', 'deepseek/deepseek-v4.1-flash', 'completed', 1759363200000, 1000, 5, 0, 0, 0);",
  );
  assert.equal(r.status, 0, `sandbox sub-ledger write failed: ${r.stderr}`);
  return db;
}

test("discovery: session table project roots → .lazyzcode walk collects sandbox sub-ledgers, prunes vendored dirs, skips empty-schema dbs", { skip: !HAS_SQLITE3 && "sqlite3 missing" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-sandbox-"));
  try {
    // Host ledger: session table only knows two project roots
    const hostDir = path.join(tmp, "host", ".zcode", "cli", "db");
    await fs.mkdir(hostDir, { recursive: true });
    const hostDb = path.join(hostDir, "db.sqlite");
    const projectA = path.join(tmp, "projectA");
    const projectB = path.join(tmp, "projectB");
    const projectC = path.join(tmp, "projectC"); // No .lazyzcode → excluded
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });
    await fs.mkdir(projectC, { recursive: true });
    const w = sql(
      hostDb,
      "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);" +
        "INSERT INTO session VALUES ('h1', '" + projectA.replace(/'/g, "''") + "');" +
        "INSERT INTO session VALUES ('h2', '" + projectB.replace(/'/g, "''") + "');" +
        "INSERT INTO session VALUES ('h3', '" + projectC.replace(/'/g, "''") + "');",
    );
    assert.equal(w.status, 0, `host ledger write failed: ${w.stderr}`);

    // projectA: regular review run directory sub-ledger (discovered) + nested eval repo sub-ledger (discovered) + vendored directory decoy (pruned)
    const sbA1 = await makeSandboxDb(path.join(projectA, ".lazyzcode", "review", "fx.a1.r1"));
    const sbA2 = await makeSandboxDb(path.join(projectA, ".lazyzcode", "artifacts", "v040", "runs", "35-x", "repo", ".lazyzcode", "review", "g.a1.r1"));
    await fs.mkdir(path.join(projectA, ".lazyzcode", "x", "node_modules", "pkg", "home", ".zcode", "cli", "db"), { recursive: true });
    const decoyA = path.join(projectA, ".lazyzcode", "x", "node_modules", "pkg", "home", ".zcode", "cli", "db", "db.sqlite");
    await fs.writeFile(decoyA, "placeholder-not-real-schema");

    // projectB: incomplete schema db (empty library) → hasZcodeNativeUsageSchema excludes
    await fs.mkdir(path.join(projectB, ".lazyzcode", "review", "y.a1.r1", "home", ".zcode", "cli", "db"), { recursive: true });
    const emptyB = path.join(projectB, ".lazyzcode", "review", "y.a1.r1", "home", ".zcode", "cli", "db", "db.sqlite");
    const we = sql(emptyB, "CREATE TABLE something_else (id TEXT);");
    assert.equal(we.status, 0, `empty db write failed: ${we.stderr}`);

    const found = discoverZcodeSandboxDbs(hostDb);
    // Discovery outputs realpath-normalized paths (macOS /var→/private/var solidified in the wild, both sides of the comparison must be normalized)
    const names = found.sort().map((p) => fsSync.realpathSync(p));
    assert.deepEqual(names, [sbA1, sbA2].sort().map((p) => fsSync.realpathSync(p)), "only collect real sub-ledgers with complete schemas (vendored dirs and empty dbs pruned)");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("discovery: absent host ledger / unreadable → fail-soft returns []", async () => {
  assert.deepEqual(discoverZcodeSandboxDbs(null), []);
  assert.deepEqual(discoverZcodeSandboxDbs(path.join(os.tmpdir(), "tt-zcode-sandbox-does-not-exist", "db.sqlite")), []);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-sandbox-"));
  try {
    const notADb = path.join(tmp, "db.sqlite");
    await fs.writeFile(notADb, "definitely not sqlite");
    assert.deepEqual(discoverZcodeSandboxDbs(notADb), []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("ingestion: parseOpencodeDbIncremental (zcodeSandbox namespace) → queue records materialize, second pass no duplicates", { skip: !HAS_SQLITE3 && "sqlite3 missing" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-sandbox-parse-"));
  try {
    const sandboxDb = await makeSandboxDb(path.join(tmp, "projectA", ".lazyzcode", "review", "fx.a1.r1"));
    const messages = readZcodeDbMessages(sandboxDb);
    assert.equal(messages.length, 1, "sandbox sub-ledger parses out one completed line");
    assert.equal(messages[0].data.providerID, "new-provider");
    assert.equal(messages[0].data.modelID, "deepseek/deepseek-v4.1-flash");

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {};
    const first = await parseOpencodeDbIncremental({
      dbMessages: messages, dbPath: sandboxDb, cursors, queuePath, source: "zcode", cursorKey: "zcodeSandbox",
    });
    assert.ok(first.eventsAggregated >= 1, "first pass generates bucket events");
    const queueContent = await fs.readFile(queuePath, "utf8");
    const rows = queueContent.trim().split("\n").map((l) => JSON.parse(l));
    const zcodeRows = rows.filter((r) => r.source === "zcode");
    assert.ok(zcodeRows.length >= 1);
    const totalIn = zcodeRows.reduce((acc, r) => acc + (r.input_tokens || 0), 0);
    assert.equal(totalIn, 1000, "queue bucket input tokens match sub-ledger line (zcode inclusive-token convention: input already contains cache)");

    // Second pass: same sub-ledger re-read → message index dedup, no duplicate bucket events
    const second = await parseOpencodeDbIncremental({
      dbMessages: readZcodeDbMessages(sandboxDb), dbPath: sandboxDb, cursors, queuePath, source: "zcode", cursorKey: "zcodeSandbox",
    });
    assert.equal(second.eventsAggregated, 0, "same sessionId second read not re-accumulated (dedup semantics)");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// A host ledger that is also schema-valid: only the exclusion set can keep it out of the sandbox result.
async function makeHostDb(dir, projectDirs) {
  const dbDir = path.join(dir, ".zcode", "cli", "db");
  await fs.mkdir(dbDir, { recursive: true });
  const db = path.join(dbDir, "db.sqlite");
  const values = projectDirs.map((d, i) => `('host-sess-${i}', '${d.replace(/'/g, "''")}')`).join(", ");
  const r = sql(db, `${MU_SCHEMA} INSERT INTO session VALUES ${values};`);
  assert.equal(r.status, 0, `host ledger write failed: ${r.stderr}`);
  return db;
}

const rp = (p) => fsSync.realpathSync(p);
const sortedRp = (list) => list.map(rp).sort();

test("discovery: several host ledgers union their session roots; a root known to two ledgers is collected once", { skip: !HAS_SQLITE3 && "sqlite3 missing" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-sandbox-multi-"));
  try {
    const projectA = path.join(tmp, "projectA");
    const projectB = path.join(tmp, "projectB");
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });
    const hostA = await makeHostDb(path.join(tmp, "hostA"), [projectA]);
    const hostB = await makeHostDb(path.join(tmp, "hostB"), [projectB]);
    const sbA = await makeSandboxDb(path.join(projectA, ".lazyzcode", "review", "a.a1.r1"));
    const sbB = await makeSandboxDb(path.join(projectB, ".lazyzcode", "review", "b.a1.r1"));

    assert.deepEqual(sortedRp(discoverZcodeSandboxDbs(hostA)), [rp(sbA)], "one ledger only reaches the projects its own session table knows");
    assert.deepEqual(sortedRp(discoverZcodeSandboxDbs([hostA, hostB])), [rp(sbA), rp(sbB)].sort(), "disjoint ledgers contribute both installs");

    const hostC = await makeHostDb(path.join(tmp, "hostC"), [projectA]);
    assert.deepEqual(sortedRp(discoverZcodeSandboxDbs([hostA, hostC])), [rp(sbA)], "a root shared by two ledgers must not double-collect");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("discovery: a host ledger parked under a .lazyzcode/**/home path is never re-ingested as a sandbox", { skip: !HAS_SQLITE3 && "sqlite3 missing" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-sandbox-hostexcl-"));
  try {
    const projectA = path.join(tmp, "projectA");
    const projectB = path.join(tmp, "projectB");
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });
    // hostB sits exactly where a sub-ledger would, and carries the same schema — the exclusion set is
    // the only thing separating it from a sandbox. The two namespaces ("zcode" / "zcodeSandbox") do not
    // dedupe each other, so emitting it here would ingest the whole host ledger a second time.
    const hostB = await makeHostDb(path.join(projectA, ".lazyzcode", "review", "hb", "home"), [projectB]);
    const hostA = await makeHostDb(path.join(tmp, "hostA"), [projectA]);
    const sbA = await makeSandboxDb(path.join(projectA, ".lazyzcode", "review", "real.a1.r1"));
    const sbB = await makeSandboxDb(path.join(projectB, ".lazyzcode", "review", "b.a1.r1"));

    const found = sortedRp(discoverZcodeSandboxDbs([hostA, hostB]));
    assert.ok(!found.includes(rp(hostB)), "host ledger must not appear among sandbox sub-ledgers");
    assert.deepEqual(found, [rp(sbA), rp(sbB)].sort());
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("discovery: win32 TOKENTRACKER_WSL_MODE=both keeps two live ledgers — `native || wsl` would lose the second install", { skip: !HAS_SQLITE3 && "sqlite3 missing" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-sandbox-both-"));
  try {
    const projectA = path.join(tmp, "projectA");
    const projectB = path.join(tmp, "projectB");
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });
    const nativeHost = await makeHostDb(path.join(tmp, "native"), [projectA]);
    const wslHost = await makeHostDb(path.join(tmp, "wslhome"), [projectB]);
    const sbA = await makeSandboxDb(path.join(projectA, ".lazyzcode", "review", "a.a1.r1"));
    const sbB = await makeSandboxDb(path.join(projectB, ".lazyzcode", "review", "b.a1.r1"));

    // Constructed rather than probed: macOS cannot reach this mode, so the resolver is driven with
    // injected win32 deps to keep the dual-install surface under real coverage.
    const paths = resolveZcodeInstallPaths({ nativeValue: nativeHost, wslValue: wslHost }, { TOKENTRACKER_WSL_MODE: "both" }, { platform: "win32" });
    assert.ok(paths.native && paths.wsl, "both mode must leave both ledgers live, otherwise this test proves nothing");

    assert.deepEqual(sortedRp(discoverZcodeSandboxDbs(paths.native || paths.wsl)), [rp(sbA)], "the pre-fix single-slot call covered only the native install");
    assert.deepEqual(
      sortedRp(discoverZcodeSandboxDbs([paths.native, paths.wsl])),
      [rp(sbA), rp(sbB)].sort(),
      "passing both resolved slots recovers the WSL install's sandboxes",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
