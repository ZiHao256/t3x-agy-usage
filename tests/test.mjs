// Antigravity 官方额度扩展的测试：输出解析、环境清理、影子 HOME、缓存与合并、拒绝有消耗的结果。
// 用法：npm test（不依赖 npm 包，Node 22+）。CLI 用一个假的 shell 脚本代替，不联网。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activate, cleanHidden, cliEnv, createReader, parseUsage } from "../server.mjs";

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

test("解析 /usage：中文标签", () => {
  assert.deepEqual(parseUsage(JSON.stringify(fixture), "zh").map((w) => w.label), ["Gemini · 每周", "Gemini · 5 小时", "Claude 与 GPT（共用） · 每周", "Claude 与 GPT（共用） · 5 小时"]);
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

test("状态、立即重读、隐藏窗口、恢复被停掉的 CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const cli = fakeCli(root);
    let lang = "en";
    let hidden = [];
    const reader = createReader({ dataDir: path.join(root, "data"), lang: () => lang, hidden: () => hidden });
    assert.deepEqual(reader.status(), { instances: [], blocked: false });
    const a = { instanceId: "antigravity", profileDirectory: profile(root, "a"), executablePath: cli.bin, environment: { PATH: process.env.PATH, SECRET: "s" } };
    await reader.read(a);
    hidden = ["gemini-5h", "3p-5h"];
    lang = "zh";
    assert.deepEqual((await reader.read(a)).windows.map((w) => w.label), ["Gemini · 每周", "Claude 与 GPT（共用） · 每周"], "缓存里的结果也按当前语言和设置给");
    const st = reader.status();
    assert.equal(st.instances[0].windows.length, 4, "状态不按隐藏过滤");
    assert.equal(st.instances[0].windows[1].label, "Gemini · 5 小时");
    assert(!JSON.stringify(st).includes("SECRET"), "状态里不带环境变量");
    const runs = () => cli.calls().filter((l) => l.startsWith("-p ")).length;
    assert.equal(runs(), 1);
    await reader.reread();
    assert.equal(runs(), 2, "立即重读不等缓存");

    // 有消耗：停掉 CLI，恢复后重新按没确认过安全的处理
    fs.writeFileSync(cli.out, JSON.stringify({ ...fixture, num_turns: 1, usage: { total_tokens: 9 } }));
    await reader.reread();
    assert.equal(reader.status().blocked, true);
    assert.match(reader.status().instances[0].error, /当成了对话/);
    await assert.rejects(reader.read(a), /当成了对话/, "一分钟内复用失败结果");
    fs.writeFileSync(cli.out, JSON.stringify(fixture));
    reader.unblock();
    assert.equal(reader.status().blocked, false);
    assert.equal((await reader.read(a)).windows.length, 2, "恢复后马上能读");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("边界：全隐藏时照常显示、格式不对的部分跳过、一小时没来读的实例不列也不重读", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const cli = fakeCli(root);
    let t = 1_000_000;
    const reader = createReader({ dataDir: path.join(root, "data"), now: () => t, hidden: () => ["gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"] });
    const a = { instanceId: "antigravity", profileDirectory: profile(root, "a"), executablePath: cli.bin, environment: { PATH: process.env.PATH } };
    assert.equal((await reader.read(a)).windows.length, 4, "全被关掉时照常显示");
    const bad = structuredClone(fixture);
    bad.command.data.groups[0].buckets = 5;
    bad.command.data.groups.push({ name: 7, buckets: [{ id: "x", name: 8, remaining_fraction: 0.5 }] });
    fs.writeFileSync(cli.out, JSON.stringify(bad));
    const b = { ...a, instanceId: "antigravity_3", profileDirectory: profile(root, "b") };
    assert.deepEqual((await reader.read(b)).windows.map((w) => w.label), ["x · Quota"], "名字不是字符串也不抛");
    bad.command.data.groups = [null, { buckets: [null, { id: 3 }] }, 5];
    fs.writeFileSync(cli.out, JSON.stringify(bad));
    const c = { ...a, instanceId: "antigravity_4", profileDirectory: profile(root, "c") };
    assert.deepEqual((await reader.read(c)).windows, [], "格式不对的部分跳过");
    assert.deepEqual(reader.status().instances.map((i) => i.windows.length), [4, 3, 0], "其他实例的状态照常");
    const runs = () => cli.calls().filter((l) => l.startsWith("-p ")).length;
    const before = runs();
    t += 61 * 60_000;
    assert.deepEqual(reader.status().instances, [], "一小时没来读的不列");
    await reader.reread();
    assert.equal(runs(), before, "也不重读");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("恢复运行后，恢复前就在跑的读取成功了也不能把 CLI 标成安全", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    // MODE=slow 慢一点成功、MODE=spent 报有消耗；每次运行记 start / end，看有没有重叠
    const bin = path.join(root, "agy");
    fs.writeFileSync(path.join(root, "ok.json"), JSON.stringify(fixture));
    fs.writeFileSync(path.join(root, "spent.json"), JSON.stringify({ ...fixture, num_turns: 1, usage: { total_tokens: 3 } }));
    fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.5.14; exit 0; fi
echo "start $MODE" >> "${root}/runs.log"
[ "$MODE" = slow ] && sleep 0.6
[ "$MODE" = pair ] && sleep 0.3
echo "end $MODE" >> "${root}/runs.log"
if [ "$MODE" = spent ]; then cat "${root}/spent.json"; else cat "${root}/ok.json"; fi
`, { mode: 0o755 });
    const reader = createReader({ dataDir: path.join(root, "data") });
    const ctx = (name, MODE) => ({ instanceId: name, profileDirectory: profile(root, name), executablePath: bin, environment: { PATH: process.env.PATH, MODE } });
    await reader.read(ctx("first", "ok")); // 先确认安全
    const slow = reader.read(ctx("slow", "slow"));
    await assert.rejects(reader.read(ctx("bad", "spent")), /当成了对话/);
    reader.unblock();
    await slow; // 恢复前就在跑的这次成功了
    fs.writeFileSync(path.join(root, "runs.log"), "");
    await Promise.all([reader.read(ctx("p1", "pair")), reader.read(ctx("p2", "pair"))]);
    const log = fs.readFileSync(path.join(root, "runs.log"), "utf8").trim().split("\n");
    assert.deepEqual(log, ["start pair", "end pair", "start pair", "end pair"], "恢复后第一次读取前一次只跑一个");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("设置：并发保存时内存和磁盘一致", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const handlers = {};
    await activate({ dataDir: path.join(root, "data"), log() {}, lang: () => "en", usage: { registerSource() {} }, handle: (n, fn) => (handlers[n] = fn) });
    await Promise.all([handlers.setHidden(["3p-5h"]), handlers.setHidden(["gemini-5h"]), handlers.setHidden(["3p-weekly"])]);
    const disk = JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf8")).hidden;
    assert.deepEqual(disk, ["3p-weekly"]);
    assert.deepEqual((await handlers.status()).hidden, disk);
    assert.deepEqual(fs.readdirSync(path.join(root, "data")).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("activate：登记来源和设置面板的调用，隐藏的窗口存进数据目录", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-agy-"));
  try {
    const t3x = (seen, handlers) => ({ dataDir: path.join(root, "data"), log() {}, lang: () => "en", usage: { registerSource: (s) => seen.push(s) }, handle: (name, fn) => (handlers[name] = fn) });
    const seen = [];
    const handlers = {};
    const off = await activate(t3x(seen, handlers));
    assert.equal(seen[0].driver, "antigravity");
    assert.equal(typeof off, "function");
    assert.deepEqual(Object.keys(handlers).sort(), ["reread", "setHidden", "status", "unblock"]);
    assert.deepEqual(await handlers.status(), { instances: [], blocked: false, hidden: [] });
    assert.deepEqual((await handlers.setHidden(["3p-5h", "3p-5h", "../x", 1])).hidden, ["3p-5h"]);
    await assert.rejects(async () => handlers.setHidden("3p-5h"), /数组/);
    const again = {};
    await activate(t3x([], again));
    assert.deepEqual((await again.status()).hidden, ["3p-5h"], "重新启用后还在");
    fs.writeFileSync(path.join(root, "data", "config.json"), "{");
    const broken = {};
    await activate(t3x([], broken));
    assert.deepEqual((await broken.status()).hidden, [], "设置文件坏了用默认值");
    assert.equal(cleanHidden(Array.from({ length: 40 }, (_, i) => `w${i}`)).length, 32);
    off();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

let passed = 0;
for (const [name, fn] of tests) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}
console.log(`\n全部通过（${passed} 项）`);
