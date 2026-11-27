**简体中文** | [English](README.en.md)

# Antigravity 官方额度

T3 额度面板里的 Antigravity 额度由官方 CLI 的 `/usage` 读取：每个 T3 Antigravity 实例用自己的登录，不发消息、不耗 token，也不读 token 文件、不冒充客户端去调 Google 的内部接口。T3 Code 0.1.13 起自己不再读 Antigravity 额度，不装这个扩展，额度面板里就没有这一项；在 0.1.12 上装了它，T3 就不再用自己那套拿 token 调接口的读取。

![T3 用量面板里显示两个实例经 CLI 读到的 Antigravity 额度](docs/usage-panel.png)

[T3 Code Extensions](https://github.com/ZiHao256/t3code-extensions) 的扩展，T3 Code Extensions 是 [T3 Code](https://github.com/pingdotgg/t3code) 的非官方扩展宿主。

## 设置

设置 → 扩展 → Antigravity 官方额度 →「设置」：

- 读取状态：每个 Antigravity 实例最近一次读取的时间、读到几个额度窗口，或者失败原因。
- 立即重读：不等一分钟的缓存，马上用 CLI 再读一次，额度面板下次刷新时显示新结果。
- 恢复运行：某次读取可能消耗了 token 时，扩展会停掉那个 CLI，这里会出现「恢复运行」按钮，确认 CLI 没问题后点它。
- 额度面板里显示：按窗口开关（比如只看每周额度），至少留一个。
- 额度名称跟着 T3 的界面语言，中文下是“Gemini · 每周”“Claude 与 GPT（共用） · 5 小时”。

![设置面板：两个实例的读取状态、立即重读，以及额度面板里显示哪些额度](docs/settings.png)

## 让 agent 安装

把下面的提示词发给 Claude Code、Codex 等 coding agent：

```text
帮我在这台 Mac 上给 T3 Code 装「Antigravity 官方额度」扩展（https://github.com/ZiHao256/t3x-agy-usage）。
1. 确认已安装 T3 Code Extensions：T3 Code 0.1.13 要 v0.6.0 或更新，0.1.12 要 v0.4.0 – v0.5.0（在它的仓库目录跑 `git describe --tags`；在应用里更新过的，以 设置 → 扩展 里的提示为准）。没装或版本旧，先按 https://github.com/ZiHao256/t3code-extensions 里「让 agent 安装」一节装好；要退出 T3 Code 前先问我。
2. 打开 ~/Applications/T3 Code Extensions.app，进入 设置 → 扩展 →「浏览」，在社区扩展里安装 t3x-agy-usage；或者把 https://github.com/ZiHao256/t3x-agy-usage 粘贴到链接框里点「添加」。确认框里核对来源是 ZiHao256/t3x-agy-usage 再确认。这是后台扩展，确认框里会提示「后台」权限，属正常。
3. 在「已安装」里确认它已启用，告诉我版本号。
如果你没法操作应用界面，做完第 1 步后，把第 2、3 步具体点哪里告诉我。
```

## 原理

- 后台扩展（`apiVersion` 6，`permissions: ["ui", "server"]`）：读取在 T3 后台里以你的用户权限运行；设置面板（`web.js`）经 `host.server.call` 找后台要状态、改设置。设置存在扩展的数据目录里，卸载时一起删。
- 每个实例跑一次 T3 给它解析出的 CLI：`<cli> -p /usage --output-format json --print-timeout 20s`。`HOME` 指向这个实例的影子目录，里面的 `.gemini/antigravity-cli` 链到 T3 给这个实例的登录目录，所以各实例读各自的账号。会切换登录方式的环境变量（`GEMINI_API_KEY`、`GOOGLE_*` 等）被去掉，自动更新和浏览器都关掉。
- 不链接实例的 MCP 配置，否则每次读取 CLI 都会把配置的 MCP 服务器全部拉起来。
- 防止 `/usage` 被当成对话发出去：低于 1.1.11 的 CLI 不运行（CLI 文件一变就重新查版本）；只接受 `usage` 命令、0 轮、各项 token 都是 0 的结果；一个 CLI 通过一次之前同时只跑一个；一旦可能有消耗，重新启用扩展或换 CLI 之前不再运行它。这些措施把最坏情况限制在一条消息，不能保证绝对不会发生。
- 扩展自己没有定时器，T3 什么时候读 Antigravity 额度它就什么时候读：主要是 T3 的提供方健康检查（设置 → 智能体提供方 → 高级 → 健康检查间隔，设成 0 就不定时检查）和打开用量面板的时候。
- 每个实例的结果（包括错误）复用 60 秒，登录文件变了就重新读；并发读取合并成一次。每次大约 6–9 秒，45 秒没结束就终止。
- 启用期间不用 T3 自己的读取方式，出错也不退回；停用或卸载扩展就恢复。

只接手用 Google 登录（`oauth-*`）的实例，其他照旧。CLI 只读实例目录里的登录文件，只存在系统钥匙串里的企业账号登录会显示为未登录。

## 开发

- `npm test` 运行测试（Node 22+，不依赖 npm 包；用假的 CLI，不联网）。
- 试改动：设置 → 扩展 →「添加本地扩展」选本目录，改完点卡片上的刷新。

## 社区

本项目积极参与并认可 [LINUX DO 社区](https://linux.do)。

## 许可

MIT
