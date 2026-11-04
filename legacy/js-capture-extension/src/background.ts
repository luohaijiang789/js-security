import { Collector } from "./capture";
import { httpURL } from "./model";
import * as store from "./store";
const collector = new Collector(chrome);
let mutations = collector.recover();
chrome.action.onClicked.addListener(
  () => void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") }),
);
chrome.debugger.onEvent.addListener((s, m, p) => collector.event(s, m, p));
chrome.debugger.onDetach.addListener((s) => collector.detached(s));
chrome.tabs.onCreated.addListener((t) => {
  if (t.id !== undefined && httpURL(t.url))
    void mutations.then(() => collector.attach(t.id!, t.url!));
});
chrome.tabs.onUpdated.addListener((id, change, t) => {
  if (change.url && httpURL(t.url))
    void mutations.then(() => collector.attach(id, t.url!));
});
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("index.html")
  )
    return false;
  const action = async () => {
    switch (m.type) {
      case "state":
        return {
          tasks: await store.tasks(),
          active_id: collector.task?.id ?? null,
        };
      case "start":
        return { id: await collector.start() };
      case "pause":
        if (collector.task?.id !== m.id) throw Error("请选择当前采集任务");
        await collector.stop(true);
        return {};
      case "stop":
        if (collector.task?.id !== m.id) throw Error("请选择当前采集任务");
        await collector.stop();
        return {};
      case "resume":
        await collector.resume(m.id);
        return {};
      case "freeze":
        return { snapshot: await store.freeze(m.id) };
      default:
        throw Error("未知操作");
    }
  };
  if (m.type === "state")
    void action().then(
      (value) => reply({ ok: true, ...value }),
      () => reply({ ok: false, error: "读取任务失败" }),
    );
  else {
    mutations = mutations
      .catch(() => {})
      .then(async () => {
        try {
          reply({ ok: true, ...(await action()) });
        } catch (e) {
          reply({
            ok: false,
            error: e instanceof Error ? e.message : "任务操作失败",
          });
        }
      });
  }
  return true;
});
