// 使用说明弹窗 + 顶栏宽度 + 主题快捷键
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = "C:/Users/Administrator/Desktop/JS Editor";
const FILE = "file:///" + ROOT.replace(/ /g, "%20") + "/js-playground.html";
const PORT = 9521;
const HERE = import.meta.dirname;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${HERE}/.e2e-help-profile`,
  "--window-size=1440,900", "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) break;
  } catch (e) {}
  await sleep(150);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pend.set(mid, { resolve: res, reject: rej }));
};
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: FILE });
await sleep(1400);
await ev(`localStorage.clear()`);
await send("Page.reload", { ignoreCache: true });
await sleep(1400);

const report = {};

// 1. 打开
await ev(`document.getElementById('helpBtn').click()`);
await sleep(260);
report.opened = await ev(`(() => {
  const v = document.getElementById('helpVeil');
  return {
    open: v.classList.contains('open'),
    display: getComputedStyle(v).display,
    sections: v.querySelectorAll('.hp-body section').length,
    rows: v.querySelectorAll('.hp-row').length,
    navs: v.querySelectorAll('.hp-nav a').length,
    notes: v.querySelectorAll('.hp-note').length,
    focus: document.activeElement.id,
    cardW: Math.round(v.querySelector('.hp-card').getBoundingClientRect().width),
    bodyScrollable: (() => { const b = document.getElementById('helpBody'); return b.scrollHeight - b.clientHeight; })()
  };
})()`);

// 2. 分类跳转
report.jump = [];
for (const go of ["hp-mock", "hp-file", "hp-ui"]) {
  await ev(`(() => {
    const a = document.querySelector('.hp-nav a[data-go="${go}"]');
    a.click();
  })()`);
  await sleep(240);
  report.jump.push(await ev(`(() => {
    const b = document.getElementById('helpBody');
    const sec = document.getElementById('${go}');
    const h3 = sec.querySelector('h3');
    return { go: '${go}', scrollTop: Math.round(b.scrollTop), h3TopInBody: Math.round(h3.getBoundingClientRect().top - b.getBoundingClientRect().top) };
  })()`));
}

// 3. Esc 关闭 + 焦点回编辑器
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(250);
report.escClose = await ev(`(() => ({
  open: document.getElementById('helpVeil').classList.contains('open'),
  active: document.activeElement.className
}))()`);

// 4. 遮罩关闭
await ev(`document.getElementById('helpBtn').click()`);
await sleep(200);
const veilBox = await ev(`(() => { const r = document.getElementById('helpVeil').getBoundingClientRect(); return { x: 8, y: Math.round(r.height / 2) }; })()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: veilBox.x, y: veilBox.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: veilBox.x, y: veilBox.y, button: "left", clickCount: 1 });
await sleep(200);
report.veilClick = await ev(`document.getElementById('helpVeil').classList.contains('open')`);

// 5. X 关闭
await ev(`document.getElementById('helpBtn').click()`);
await sleep(180);
await ev(`document.getElementById('helpX').click()`);
await sleep(180);
report.xClose = await ev(`document.getElementById('helpVeil').classList.contains('open')`);

// 6. Ctrl+Shift+L 切主题（本来是 data-tip 承诺但没实现的快捷键）
const themeBefore = await ev(`document.documentElement.getAttribute('data-theme') || 'light'`);
await ev(`document.querySelector('.CodeMirror').CodeMirror.focus()`);
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "L", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 10 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "L", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 10 });
await sleep(250);
report.themeHotkey = { before: themeBefore, after: await ev(`document.documentElement.getAttribute('data-theme') || 'light'`) };
if (report.themeHotkey.after !== "dark") await ev(`document.getElementById('themeBtn').click()`);
await sleep(200);

// 7. 深色截图
await ev(`document.getElementById('helpBtn').click()`);
await sleep(260);
let shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(HERE, "shot-help-dark.png"), Buffer.from(shot.data, "base64"));

// 8. 浅色截图
await ev(`document.getElementById('themeBtn').click()`);
await sleep(260);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(HERE, "shot-help-light.png"), Buffer.from(shot.data, "base64"));

// 9. 窄屏 700
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 820, deviceScaleFactor: 1, mobile: false });
await sleep(320);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(HERE, "shot-help-700.png"), Buffer.from(shot.data, "base64"));
report.narrow = await ev(`(() => {
  const card = document.querySelector('.hp-card');
  const r = card.getBoundingClientRect();
  const row = document.querySelector('.hp-row');
  return {
    cardW: Math.round(r.width), cardH: Math.round(r.height),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rowCols: getComputedStyle(row).gridTemplateColumns,
    cardOver: card.scrollWidth - card.clientWidth
  };
})()`);
await send("Emulation.clearDeviceMetricsOverride");
await sleep(200);

// 10. 关闭后顶栏各宽度溢出
await ev(`document.getElementById('helpX').click()`);
await sleep(200);
report.topbar = [];
for (const w of [1440, 1360, 1280, 1240, 1180, 1100, 1000, 940, 900, 880, 820, 780, 760, 720, 700, 680]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(140);
  const o = await ev(`(() => {
    const tb = document.querySelector('.topbar');
    return { over: tb.scrollWidth - tb.clientWidth, brandLines: Math.round(document.querySelector('.brand').getBoundingClientRect().height) };
  })()`);
  report.topbar.push({ w, ...o });
}
await send("Emulation.clearDeviceMetricsOverride");

report.errors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
chrome.kill();
