// Antigravity 官方额度：T3 Code Extensions 的后台扩展（在 T3 后台里运行）。
// 每个 T3 Antigravity 实例跑一次官方 CLI 的 /usage 斜杠命令（不发消息、不耗 token），换算成 T3 额度面板的窗口。
// 不读 token、不直接请求 Google：登录状态由 CLI 自己从这个实例的配置目录读。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CACHE_MS = 60_000; // T3 失败后 30 秒重试、启动时各实例一起读：一分钟内复用结果，免得反复起进程
const RUN_TIMEOUT_MS = 45_000;
const KILL_GRACE_MS = 3_000; // SIGTERM 之后还不退就 SIGKILL
const MAX_OUTPUT = 1 << 20;
const MIN_VERSION = [1, 1, 11]; // 更早的版本不认识 /usage，会把它当成对话发给模型
const ARGS = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"];
// 这些变量会让 CLI 改用 API key、Vertex 或别的目录登录，读到的就不是这个实例的账号了。
// AGY_ACP_* 是 T3 给 ACP 进程用的（项目、OAuth 开关、存储），T3 自己启动 CLI 前也会去掉。
const DROP_ENV = /^(GEMINI_API_KEY|GOOGLE_\w*|GCLOUD_PROJECT|CLOUDSDK_CORE_PROJECT|GEMINI_HOME|AGY_ACP_\w*|ELECTRON_RUN_AS_NODE|T3X_SERVER_DIR)$/;
const FAMILY = [
  ["gemini-", "Gemini"],
  ["3p-", "Claude & GPT (shared)"],
];
const WINDOWS = {
  weekly: { kind: "weekly", label: "Weekly", mins: 10080 },
  "5h": { kind: "session", label: "5-hour", mins: 300 },
};

/** CLI 的 JSON 输出 → T3 的额度窗口；不是一次零消耗的 /usage 就抛错。 */
export function parseUsage(stdout) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`CLI 没有输出 JSON：${firstLine(stdout) || "（空）"}`);
  }
  // 确认不了“没发消息”就当发了：轮数不是 0、没有 total_tokens、用量里任何一个数字不是 0。
  const usage = out?.usage ?? {};
  const spent = out?.num_turns !== 0 || typeof usage.total_tokens !== "number" || Object.values(usage).some((n) => typeof n === "number" && n !== 0);
  if (spent) throw new SpentError(`CLI 可能把 /usage 当成了对话（${out?.num_turns} 轮，用量 ${JSON.stringify(out?.usage)}）`);
  if (out.status !== "SUCCESS") throw new Error(firstLine(out.response) || `CLI 返回 ${out.status}`);
  if (out.command?.name !== "usage") throw new Error(`CLI 返回的不是 /usage 的结果：${out.command?.name}`);
  const groups = out.command.data?.groups;
  if (!Array.isArray(groups)) throw new Error("CLI 的 /usage 输出里没有额度分组");
  return toWindows(groups);
}

export function toWindows(groups) {
  const windows = [];
  for (const group of groups) {
    for (const b of group?.buckets ?? []) {
      if (typeof b?.id !== "string" || !Number.isFinite(b.remaining_fraction)) continue;
      const family = FAMILY.find(([prefix]) => b.id.startsWith(prefix))?.[1] ?? (group.name?.trim() || b.id);
      const w = WINDOWS[b.window];
      const reset = Date.parse(b.reset_time ?? "");
      windows.push({
        id: b.id,
        label: `${family} · ${w?.label ?? (b.name?.trim() || "Quota")}`,
        kind: w?.kind ?? "other",
        usedPercent: (1 - Math.max(0, Math.min(1, b.remaining_fraction))) * 100,
        ...(reset > Date.UTC(2000, 0, 1) ? { resetsAt: new Date(reset).toISOString() } : {}), // 没用过的额度重置时间是 1970 年占位
        ...(w ? { windowDurationMins: w.mins } : {}),
      });
    }
  }
  return windows;
}

/** 给 CLI 的环境：去掉会换登录方式的变量；HOME 指向影子目录，让 CLI 读这个实例的登录。 */
export function cliEnv(base, home) {
  const env = Object.fromEntries(Object.entries(base ?? {}).filter(([k, v]) => typeof v === "string" && !DROP_ENV.test(k)));
  return {
    ...env,
    HOME: home,
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1", // 读实例目录里的 token 文件，不碰系统钥匙串里的默认账号
    AGY_CLI_DISABLE_AUTO_UPDATE: "true", // 只认 true；写 1 照样自动更新
    BROWSER: "false",
    SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", // 登录失效时不弹浏览器
  };
}

class SpentError extends Error {}
const firstLine = (text) => String(text ?? "").trim().split("\n")[0].slice(0, 300);

function run(file, args, { env, cwd, children, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    // 不等 close：进程不理 SIGTERM、或者后代进程攥着输出管道时 close 可能永远不来。
    const stop = (message) => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS); // 不 unref：哪怕后台要退出了也先把它杀掉
      finish(reject, new Error(message));
    };
    const timer = setTimeout(() => stop(`CLI 超过 ${timeoutMs / 1000} 秒没有结束`), timeoutMs);
    const collect = (which) => (d) => {
      if (which === "out") stdout += d;
      else stderr += d;
      if (stdout.length + stderr.length > MAX_OUTPUT) stop("CLI 输出超过 1 MB");
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    child.on("error", (error) => {
      children.delete(child);
      finish(reject, error.code === "ENOENT" ? new Error(`找不到 Antigravity CLI：${file}`) : error);
    });
    child.on("close", (code, signal) => {
      children.delete(child);
      if (signal) return finish(reject, new Error(`CLI 被信号 ${signal} 结束`));
      finish(resolve, { code, stdout, stderr });
    });
  });
}

const newer = (a, b) => {
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  return true;
};

export function createReader({ dataDir, log = () => {}, now = Date.now, timeoutMs = RUN_TIMEOUT_MS }) {
  const cache = new Map(); // 实例 + 配置 → { at, windows?, error? }
  const inflight = new Map(); // 同上 → Promise
  const versions = new Map(); // CLI 身份 → Promise<版本检查>
  const safe = new Set(); // 跑通过零消耗 /usage 的 CLI 身份
  const gates = new Map(); // CLI 身份 → 还没确认安全时排队的 Promise：确认前同一个 CLI 一次只跑一个
  const spent = new Set(); // 出现过可能消耗的 CLI 身份：重新启用扩展或换了 CLI 之前不再运行
  const children = new Set();
  let disposed = false;

  // CLI 身份：路径 + 文件本身（原地升级、降级、替换都会变），版本检查和安全确认都跟着它。
  async function identity(file) {
    const st = await fs.stat(file).catch(() => {
      throw new Error(`找不到 Antigravity CLI：${file}`);
    });
    return `${file}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  }

  function guarded(file, args, opts) {
    if (disposed) throw new Error("扩展已停用");
    return run(file, args, { ...opts, children, timeoutMs });
  }

  function checkVersion(id, file, opts) {
    if (!versions.has(id)) {
      versions.set(
        id,
        guarded(file, ["--version"], opts).then(({ stdout }) => {
          const v = /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.slice(1).map(Number);
          if (!v) throw new Error(`读不出 CLI 版本：${firstLine(stdout)}`);
          if (!newer(v, MIN_VERSION)) throw new Error(`Antigravity CLI ${v.join(".")} 太旧，需要 ${MIN_VERSION.join(".")} 以上`);
        }),
      );
      versions.get(id).catch(() => versions.delete(id)); // 失败了下次再查
    }
    return versions.get(id);
  }

  // 影子 HOME：.gemini/antigravity-cli 链到 T3 给这个实例的登录目录，CLI 刷新的登录也写回那里。
  // .gemini/config 留空、不链实例的 config：那里的 mcp_config.json 会让 CLI 每次 /usage 都把所有 MCP 服务器拉起来（npx/uvx 还会下载）。
  async function shadowHome(instanceId, profileDirectory) {
    const home = path.join(dataDir, "home", createHash("sha256").update(instanceId).digest("hex").slice(0, 16));
    const gemini = path.join(home, ".gemini");
    await fs.mkdir(path.join(gemini, "config"), { recursive: true, mode: 0o700 });
    const link = path.join(gemini, "antigravity-cli");
    const target = path.join(profileDirectory, "antigravity-acp");
    if ((await fs.readlink(link).catch(() => null)) !== target) {
      await fs.rm(link, { force: true });
      await fs.symlink(target, link);
    }
    return home;
  }

  async function readFresh({ instanceId, profileDirectory, executablePath: file, environment }) {
    if (!file) throw new Error("T3 找不到 Antigravity CLI，检查设置里的路径");
    const id = await identity(file);
    if (spent.has(id)) throw new Error("之前一次读取可能消耗了 token，已停止运行这个 CLI；重新启用扩展后再试");
    await fs.access(path.join(profileDirectory, "antigravity-acp")).catch(() => {
      throw new Error("这个实例还没登录 Google，先在 T3 里用它发一条消息完成登录");
    });
    const home = await shadowHome(instanceId, profileDirectory);
    const opts = { env: cliEnv(environment, home), cwd: home };
    await checkVersion(id, file, opts);
    const once = async () => {
      if (spent.has(id)) throw new Error("同一个 CLI 刚才的读取可能消耗了 token，已停止运行它");
      const { code, stdout, stderr } = await guarded(file, ARGS, opts);
      try {
        const windows = parseUsage(stdout);
        safe.add(id);
        return windows;
      } catch (error) {
        if (error instanceof SpentError) spent.add(id);
        if (!stdout.trim() && code !== 0) throw new Error(`CLI 退出码 ${code}：${firstLine(stderr) || "没有输出"}`);
        throw error;
      }
    };
    if (safe.has(id)) return once();
    const turn = (gates.get(id) ?? Promise.resolve()).catch(() => {}).then(once);
    gates.set(id, turn);
    return turn;
  }

  async function read(ctx) {
    const { instanceId, profileDirectory, executablePath } = ctx ?? {};
    if (typeof instanceId !== "string" || typeof profileDirectory !== "string" || !path.isAbsolute(profileDirectory)) throw new Error("T3 没有给出实例目录");
    // 登录文件变了（退出、换账号）就不复用旧结果。
    const token = await fs.stat(path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token")).then((st) => st.mtimeMs, () => 0);
    const key = [instanceId, profileDirectory, executablePath ?? "", token].join("\0");
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) {
      if (hit.error) throw hit.error;
      return { windows: hit.windows };
    }
    if (!inflight.has(key)) {
      for (const k of cache.keys()) if (k.startsWith(`${instanceId}\0`)) cache.delete(k); // 同一实例只留最新配置的结果
      const job = readFresh(ctx).then(
        (windows) => cache.set(key, { at: now(), windows }),
        (error) => {
          log(`${instanceId} 读取额度失败：${error.message}`);
          cache.set(key, { at: now(), error });
        },
      );
      inflight.set(key, job.finally(() => inflight.delete(key)));
    }
    await inflight.get(key);
    const done = cache.get(key);
    if (done.error) throw done.error;
    return { windows: done.windows };
  }

  return {
    read,
    dispose() {
      disposed = true;
      for (const child of children) {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }
    },
  };
}

export function activate(t3x) {
  const reader = createReader({ dataDir: t3x.dataDir, log: t3x.log });
  t3x.usage.registerSource({ driver: "antigravity", read: reader.read });
  return () => reader.dispose();
}
