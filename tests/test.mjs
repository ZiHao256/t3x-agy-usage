// Antigravity 官方额度扩展的测试：输出解析、环境清理、影子 HOME、缓存与合并、拒绝有消耗的结果。
// 用法：npm test（不依赖 npm 包，Node 22+）。CLI 用一个假的 shell 脚本代替，不联网。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activate, cliEnv, createReader, parseUsage } from "../server.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./usage.json", import.meta.url), "utf8"));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("解析 /usage：换算已用比例、1970 年占位不当重置时间", () => {
  assert.deepEqual(parseUsage(JSON.stringify(fixture)), [
    { id: "gemini-weekly", label: "Gemini · Weekly", kind: "weekly", usedPercent: (1 - 0.6585638523101807) * 100, resetsAt: "2026-12-01T07:52:02.000Z", windowDurationMins: 10080 },
    { id: "gemini-5h", label: "Gemini · 5-hour", kind: "session", usedPercent: (1 - 0.9663717746734619) * 100, resetsAt: "2026-11-25T15:09:10.000Z", windowDurationMins: 300 },
    { id: "3p-weekly", label: "Claude & GPT (shared) · Weekly", kind: "weekly", usedPercent: 0, windowDurationMins: 10080 },
    { id: "3p-5h", label: "Claude & GPT (shared) · 5-hour", kind: "session", usedPercent: 0, windowDurationMins: 300 },
  ]);
});

test("解析 /usage：有消耗、失败、不是 JSON 都报错", () => {
  assert.throws(() => parseUsage(JSON.stringify({ ...fixture, num_turns: 1 })), /当成了对话/);
  assert.throws(() => parseUsage(JSON.stringify({ ...fixture, usage: { total_tokens: 12 } })), /"total_tokens":12/);
  assert.throws(() => parseUsage(JSON.stringify({ ...fixture, usage: { input_tokens: 3 } })), /当成了对话/, "没有 total_tokens 也算可能有消耗");
  assert.throws(() => parseUsage(JSON.stringify({ ...fixture, usage: undefined })), /当成了对话/);
  assert.throws(() => parseUsage(JSON.stringify({ ...fixture, command: { ...fixture.command, name: "status" } })), /不是 \/usage 的结果/);
  assert.throws(() => parseUsage(JSON.stringify({ ...fixture, status: "ERROR", response: "Eligibility check failed: not available in your location\nmore" })), /^Error: Eligibility check failed: not available in your location$/);
  assert.throws(() => parseUsage("Please sign in"), /没有输出 JSON：Please sign in/);
  assert.throws(() => parseUsage(JSON.stringify({ ...fixture, command: { name: "usage" } })), /没有额度分组/);
});

test("CLI 环境：去掉会换登录方式的变量，HOME 换成影子目录", () => {
  const env = cliEnv({ PATH: "/bin", GEMINI_API_KEY: "k", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_APPLICATION_CREDENTIALS: "c", GEMINI_HOME: "/x", T3X_SERVER_DIR: "/y", AGY_ACP_CCPA_PROJECT: "p", AGY_ACP_ENABLE_OAUTH: "1", HOME: "/Users/u", N: undefined }, "/shadow");
  assert.deepEqual(Object.keys(env).sort(), ["AGY_CLI_DISABLE_AUTO_UPDATE", "AGY_CLI_FORCE_FILE_TOKEN_STORAGE", "BROWSER", "HOME", "PATH", "SSH_CONNECTION"]);
  assert.equal(env.HOME, "/shadow");
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
});

// 假 CLI：记下每次调用的参数和环境，按 MODE 文件输出。
function fakeCli(dir) {
  const bin = path.join(dir, "agy");
  const out = path.join(dir, "out.json");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$* | HOME=$HOME | KEY=\${GEMINI_API_KEY-none} | FILE=$AGY_CLI_FORCE_FILE_TOKEN_STORAGE | $(readlink "$HOME/.gemini/antigravity-cli")" >> "${dir}/calls.log"
if [ "$1" = "--version" ]; then cat "${dir}/version"; exit 0; fi
sleep 0.2
cat "${out}"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "version"), "1.5.14\n");
  fs.writeFileSync(out, JSON.stringify(fixture));
  const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);
  return { bin, out, calls };
}

function profile(root, name) {
  const dir = path.join(root, "profiles", name);
  fs.mkdirSync(path.join(dir, "antigravity-acp"), { recursive: true });
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "mcp_config.json"), "{\"mcpServers\":{\"x\":{\"command\":\"npx\"}}}");
  return dir;
}

test("读取：每个实例用自己的影子 HOME，并发合并、一分钟内复用", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const cli = fakeCli(root);
    let t = 1_000_000;
    const reader = createReader({ dataDir: path.join(root, "data"), now: () => t });
    const a = { instanceId: "antigravity", profileDirectory: profile(root, "a"), executablePath: cli.bin, environment: { PATH: process.env.PATH, GEMINI_API_KEY: "k" } };
    const b = { ...a, instanceId: "antigravity_3", profileDirectory: profile(root, "b") };
    const [r1, r2, r3] = await Promise.all([reader.read(a), reader.read(a), reader.read(b)]);
    assert.equal(r1.windows.length, 4);
    assert.deepEqual(r1, r2);
    const usage = cli.calls().filter((l) => l.startsWith("-p "));
    assert.equal(usage.length, 2, "同一实例并发只跑一次");
    assert.equal(cli.calls().filter((l) => l.startsWith("--version")).length, 1, "版本只查一次");
    for (const l of usage) assert.match(l, /^-p \/usage --output-format json --print-timeout 20s \| HOME=.*\/data\/home\/[0-9a-f]{16} \| KEY=none \| FILE=1 \| .*\/profiles\/[ab]\/antigravity-acp$/);
    assert.notEqual(usage[0].split(" | ")[1], usage[1].split(" | ")[1], "两个实例的 HOME 不同");
    assert.equal(r3.windows.length, 4);
    for (const h of fs.readdirSync(path.join(root, "data", "home"))) {
      const config = path.join(root, "data", "home", h, ".gemini", "config");
      assert(!fs.lstatSync(config).isSymbolicLink() && fs.readdirSync(config).length === 0, "影子 HOME 不带实例的 MCP 配置");
    }

    await reader.read(a);
    assert.equal(cli.calls().filter((l) => l.startsWith("-p ")).length, 2, "一分钟内复用");
    t += 61_000;
    fs.writeFileSync(cli.out, JSON.stringify({ ...fixture, status: "ERROR", response: "Eligibility check failed" }));
    await assert.rejects(reader.read(a), /Eligibility check failed/);
    await assert.rejects(reader.read(a), /Eligibility check failed/, "失败也缓存，免得 T3 每 30 秒重试都起进程");
    assert.equal(cli.calls().filter((l) => l.startsWith("-p ")).length, 3);

    // 登录文件变了（换账号）：不复用一分钟内的结果
    fs.writeFileSync(cli.out, JSON.stringify(fixture));
    fs.writeFileSync(path.join(a.profileDirectory, "antigravity-acp", "antigravity-oauth-token"), "x");
    assert.equal((await reader.read(a)).windows.length, 4);
    assert.equal(cli.calls().filter((l) => l.startsWith("-p ")).length, 4);

    // CLI 被原地换掉：重新查版本
    const before = cli.calls().filter((l) => l.startsWith("--version")).length;
    fs.writeFileSync(cli.bin, fs.readFileSync(cli.bin, "utf8") + "\n# changed\n");
    t += 61_000;
    await reader.read(a);
    assert.equal(cli.calls().filter((l) => l.startsWith("--version")).length, before + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("读取：新 CLI 第一次读取前一次只跑一个，有消耗就停用，并发的其他实例不跟着跑", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const cli = fakeCli(root);
    fs.writeFileSync(cli.out, JSON.stringify({ ...fixture, num_turns: 1, usage: { total_tokens: 99 } }));
    const reader = createReader({ dataDir: path.join(root, "data") });
    const a = { instanceId: "antigravity", profileDirectory: profile(root, "a"), executablePath: cli.bin, environment: { PATH: process.env.PATH } };
    const b = { ...a, instanceId: "antigravity_3", profileDirectory: profile(root, "b") };
    const [ra, rb] = await Promise.allSettled([reader.read(a), reader.read(b)]);
    const messages = [ra.reason.message, rb.reason.message].sort(); // 谁先排到队不确定
    assert.match(messages.join("|"), /当成了对话.*\|.*已停止运行它|已停止运行它.*\|.*当成了对话/);
    assert.equal(cli.calls().filter((l) => l.startsWith("-p ")).length, 1, "只跑了第一次");
    await assert.rejects(reader.read({ ...a, instanceId: "x", profileDirectory: profile(root, "x") }), /已停止运行这个 CLI/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("读取：版本太旧、没登录、没有 CLI 路径都不运行 /usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const cli = fakeCli(root);
    fs.writeFileSync(path.join(root, "version"), "antigravity 1.1.10\n");
    const reader = createReader({ dataDir: path.join(root, "data") });
    const ctx = { instanceId: "antigravity", profileDirectory: profile(root, "a"), executablePath: cli.bin, environment: { PATH: process.env.PATH } };
    await assert.rejects(reader.read(ctx), /1\.1\.10 太旧/);
    await assert.rejects(reader.read({ ...ctx, instanceId: "x", profileDirectory: path.join(root, "none") }), /还没登录/);
    await assert.rejects(reader.read({ ...ctx, instanceId: "y", executablePath: undefined }), /找不到 Antigravity CLI/);
    await assert.rejects(reader.read({ ...ctx, instanceId: "z", executablePath: path.join(root, "missing") }), /找不到 Antigravity CLI：/);
    assert.equal(cli.calls().filter((l) => l.startsWith("-p ")).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("读取：CLI 不理 SIGTERM 也按时结束，之后同一实例还能重新读", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const cli = fakeCli(root);
    const stuck = path.join(root, "stuck");
    fs.writeFileSync(stuck, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.14; exit 0; fi\ntrap '' TERM\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
    let t = 0;
    const reader = createReader({ dataDir: path.join(root, "data"), now: () => t, timeoutMs: 1000 });
    const ctx = { instanceId: "antigravity", profileDirectory: profile(root, "a"), executablePath: stuck, environment: { PATH: process.env.PATH } };
    const started = Date.now();
    await assert.rejects(reader.read(ctx), /超过 1 秒没有结束/);
    assert(Date.now() - started < 2500, "超时就结算，不等进程（它不理 SIGTERM）退出");
    t += 61_000;
    assert.equal((await reader.read({ ...ctx, executablePath: cli.bin })).windows.length, 4, "超时的那次不会一直占着 inflight");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("activate：登记 antigravity 来源，停用时返回清理函数", () => {
  const seen = [];
  const off = activate({ dataDir: "/tmp/none", log() {}, usage: { registerSource: (s) => seen.push(s) } });
  assert.equal(seen[0].driver, "antigravity");
  assert.equal(typeof seen[0].read, "function");
  assert.equal(typeof off, "function");
});

let passed = 0;
for (const [name, fn] of tests) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}
console.log(`\n全部通过（${passed} 项）`);
