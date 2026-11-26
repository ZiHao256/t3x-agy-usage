// 设置面板：各实例最近一次读取的结果、立即重读、恢复被停掉的 CLI，以及额度面板里显示哪些窗口。
// 数据都在后台（server.mjs），经 host.server.call 取（apiVersion 6）。
const { React, h } = host;

function useBackend(lang) {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState(null); // 正在执行的调用名
  const [error, setError] = React.useState(null);
  const run = React.useCallback(async (name, data) => {
    setBusy(name);
    setError(null);
    try {
      setState(await host.server.call(name, data));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }, []);
  React.useEffect(() => {
    run("status"); // 切语言时也重取：标签由后台按界面语言给
  }, [run, lang]);
  return { state, busy, error, run };
}

function Settings({ ui }) {
  const lang = host.useLang();
  const { state, busy, error, run } = useBackend(lang);
  const time = (at) => new Date(at).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
  const instances = state?.instances ?? [];
  const hidden = state?.hidden ?? [];
  const known = new Map();
  for (const i of instances) for (const w of i.windows ?? []) known.set(w.id, w.label);
  const shown = [...known.keys()].filter((id) => !hidden.includes(id)).length;

  const rows = instances.map((i) =>
    h(ui.Row, {
      key: i.instanceId,
      title: i.instanceId,
      description: i.error
        ? host.t(`${time(i.at)} 读取失败：${i.error}`, `${time(i.at)} · Read failed: ${i.error}`)
        : host.t(`${time(i.at)} 读到 ${i.windows.length} 个额度窗口`, `${time(i.at)} · ${i.windows.length} limits read`),
    }),
  );
  if (!state && !error) rows.push(h(ui.Row, { key: "loading", title: host.t("正在获取状态…", "Loading status…") }));
  else if (state && !instances.length)
    rows.push(
      h(ui.Row, {
        key: "none",
        title: host.t("还没读过", "Not read yet"),
        description: host.t("打开 T3 的额度面板后，这里会列出每个 Antigravity 实例的结果。", "Open T3’s usage panel and each Antigravity instance’s result shows up here."),
      }),
    );

  return h(
    React.Fragment,
    null,
    error ? h(ui.Alert, { variant: "error" }, h(ui.AlertDescription, null, error)) : null,
    h(
      ui.Section,
      { title: host.t("读取状态", "Status") },
      state?.blocked
        ? h(ui.Row, {
            title: host.t("已停止运行 CLI", "CLI stopped"),
            description: host.t(
              "之前一次读取可能消耗了 token，所以停了这个 CLI。确认 CLI 版本没问题后再恢复。",
              "An earlier read may have spent tokens, so this CLI was stopped. Resume once you’ve checked the CLI version.",
            ),
            control: h(ui.Button, { size: "sm", variant: "outline", disabled: !!busy, onClick: () => run("unblock") }, host.t("恢复运行", "Resume")),
          })
        : null,
      ...rows,
      h(ui.Row, {
        title: host.t("立即重读", "Read now"),
        description: host.t(
          "不等一分钟的缓存，马上用 CLI 再读一次；额度面板下次刷新时显示新结果。",
          "Skip the one-minute cache and read again with the CLI. The usage panel shows the result on its next refresh.",
        ),
        control: h(
          ui.Button,
          { size: "sm", variant: "outline", disabled: !!busy || !instances.length, onClick: () => run("reread") },
          busy === "reread" ? host.t("读取中…", "Reading…") : host.t("重读", "Read"),
        ),
      }),
    ),
    known.size
      ? h(
          ui.Section,
          { title: host.t("额度面板里显示", "Show in the usage panel") },
          [...known].map(([id, label]) => {
            const on = !hidden.includes(id);
            return h(ui.Row, {
              key: id,
              title: label,
              control: h(ui.Switch, {
                checked: on,
                disabled: !!busy || (on && shown <= 1), // 至少留一个：全关了面板会显示“没有返回额度”
                "aria-label": label,
                onCheckedChange: (next) => run("setHidden", next ? hidden.filter((x) => x !== id) : [...hidden, id]),
              }),
            });
          }),
        )
      : null,
  );
}

host.settings(Settings);
