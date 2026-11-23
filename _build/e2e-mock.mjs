import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FILE = "file:///C:/Users/Administrator/Desktop/JS%20Editor/js-playground.html";
const PORT = 9411;
const OUT = import.meta.dirname;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + path.join(OUT, ".e2e-profile"),
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
if (!page) { console.error("chrome not ready"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pend = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
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
await sleep(1300);

// 每轮从干净状态开始：清掉上一次跑测试留下的草稿 / 主题 / 模拟页面
await ev(`localStorage.clear()`);
await send("Page.navigate", { url: FILE });
await sleep(1300);

const report = {};

// 1. 面板默认收起，按钮无激活态
report.initial = await ev(`(() => ({
  panelOpen: document.getElementById('mockPanel').classList.contains('open'),
  btnOn: document.getElementById('mockBtn').classList.contains('is-on'),
  sub: document.getElementById('mockSub').textContent
}))()`);

// 2. 点按钮展开
await ev(`document.getElementById('mockBtn').click()`);
await sleep(150);
report.opened = await ev(`(() => {
  const p = document.getElementById('mockPanel');
  const r = p.getBoundingClientRect();
  return { open: p.classList.contains('open'), h: Math.round(r.height), w: Math.round(r.width),
           focused: document.activeElement.id };
})()`);

// 3. 填一段模拟页面，跑代码验证 DOM 存在
await ev(`(() => {
  const t = document.getElementById('mockCode');
  t.value = [
    '<div class="app">',
    '  <h1 id="title">商品列表</h1>',
    '  <ul class="list"><li class="item" data-id="1">键盘</li><li class="item" data-id="2">显示器</li><li class="item" data-id="3">鼠标垫</li></ul>',
    '</div>'
  ].join('\\n');
  t.dispatchEvent(new Event('input'));
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue([
    'const items = [...document.querySelectorAll(".item")]',
    'console.log("count", items.length)',
    'console.log("title", document.getElementById("title").textContent)',
    'console.log("bodyChildren", document.body.children.length)',
    'items[0].style.color = "red"',
    'document.querySelector(".list").setAttribute("data-done", "1")',
    'console.log("attr", document.querySelector(".list").getAttribute("data-done"))',
    'console.log("color", items[0].style.color)'
  ].join('\\n'));
  document.getElementById('runBtn').click();
})()`);
await sleep(900);
report.mockRun = await ev(`(() => ({
  sub: document.getElementById('mockSub').textContent,
  btnOn: document.getElementById('mockBtn').classList.contains('is-on'),
  out: document.getElementById('consoleBody').innerText.replace(/\\n+/g, ' | '),
  state: document.getElementById('stateText').textContent
}))()`);

// 4. 第二次运行：DOM 是否被重置（不该累积节点）
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue('console.log("again", document.querySelectorAll(".item").length, document.querySelector(".list").getAttribute("data-done"))');
  document.getElementById('runBtn').click();
})()`);
await sleep(800);
report.reset = await ev(`document.getElementById('consoleBody').innerText.replace(/\\n+/g, ' | ')`);

// 5. <script> 不应执行；完整文档应能取出 body
await ev(`(() => {
  const t = document.getElementById('mockCode');
  t.value = '<html><head><title>IGNORED</title></head><body><p id="p">hi</p><script>document.body.setAttribute("data-ran","1")<\\/script></body></html>';
  t.dispatchEvent(new Event('input'));
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue([
    'console.log("p", document.getElementById("p") && document.getElementById("p").textContent)',
    'console.log("ran", document.body.getAttribute("data-ran"))'
  ].join('\\n'));
  document.getElementById('runBtn').click();
})()`);
await sleep(900);
report.scriptSkipped = await ev(`document.getElementById('consoleBody').innerText.replace(/\\n+/g, ' | ')`);

// 6. 清空模拟页面后，body 应该是空的
await ev(`document.getElementById('mockClear').click()`);
await sleep(100);
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue('console.log("empty", document.body.children.length, document.body.innerHTML.length)');
  document.getElementById('runBtn').click();
})()`);
await sleep(800);
report.cleared = await ev(`({
  out: document.getElementById('consoleBody').innerText.replace(/\\n+/g, ' | '),
  sub: document.getElementById('mockSub').textContent,
  btnOn: document.getElementById('mockBtn').classList.contains('is-on')
})`);

// 7. 示例按钮
await ev(`document.getElementById('mockSample').click()`);
await sleep(120);
report.sample = await ev(`(() => {
  const v = document.getElementById('mockCode').value;
  return { len: v.length, firstLine: v.split('\\n')[0], itemCount: (v.match(/class="item"/g) || []).length,
           sub: document.getElementById('mockSub').textContent };
})()`);

// 8. 持久化：写 localStorage 后刷新
await ev(`(() => {
  const t = document.getElementById('mockCode');
  t.value = '<section id="keep">持久化测试</section>';
  t.dispatchEvent(new Event('input'));
})()`);
await sleep(600);
await send("Page.navigate", { url: FILE });
await sleep(1400);
report.persist = await ev(`(() => ({
  saved: document.getElementById('mockCode').value,
  open: document.getElementById('mockPanel').classList.contains('open'),
  btnOn: document.getElementById('mockBtn').classList.contains('is-on'),
  sub: document.getElementById('mockSub').textContent
}))()`);

// 9. 快捷键 Alt+M
await ev(`document.querySelector('.CodeMirror').CodeMirror.focus()`);
await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 1, key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });
await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 1, key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });
await sleep(200);
report.shortcut = await ev(`document.getElementById('mockPanel').classList.contains('open')`);

// 10. 主题切换截图（先确保回到浅色）
await ev(`if (document.documentElement.dataset.theme !== 'light') document.getElementById('themeBtn').click()`);
await sleep(300);
await ev(`(() => {
  document.getElementById('mockCode').value = '<div class="wrap"><ul class="list" data-role="container" data-version="3"><li class="item" data-id="1" data-sku="KB-2024-BLK">机械键盘</li><li class="item" data-id="2" data-sku="MON-27-4K">显示器</li><li class="item" data-id="3" data-sku="MP-XL">鼠标垫</li></ul></div>';
  document.getElementById('mockCode').dispatchEvent(new Event('input'));
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue('const items = document.querySelectorAll(".item")\\nconsole.log("找到", items.length, "个节点")\\nitems.forEach(el => el.style.background = "#ffd")\\n');
  document.getElementById('runBtn').click();
})()`);
await sleep(900);

await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(300);
let shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(OUT, "shot-mock-light.png"), Buffer.from(shot.data, "base64"));

await ev(`document.getElementById('themeBtn').click()`);
await sleep(400);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(OUT, "shot-mock-dark.png"), Buffer.from(shot.data, "base64"));

// 11. 窄屏 700px
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 860, deviceScaleFactor: 2, mobile: false });
await sleep(400);
report.narrow = await ev(`(() => {
  const p = document.getElementById('mockPanel');
  const t = document.getElementById('mockCode');
  const head = document.querySelector('.console-pane .pane-head');
  return {
    panelW: Math.round(p.getBoundingClientRect().width),
    codeW: Math.round(t.getBoundingClientRect().width),
    codeH: Math.round(t.getBoundingClientRect().height),
    headOver: head.scrollWidth - head.clientWidth,
    bodyH: Math.round(document.getElementById('consoleBody').getBoundingClientRect().height)
  };
})()`);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(OUT, "shot-mock-700.png"), Buffer.from(shot.data, "base64"));

// 12. 各宽度下输出面板标题栏是否溢出
report.headOverflow = [];
for (const w of [1440, 1200, 1000, 860, 760, 700]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(220);
  const row = await ev(`(() => {
    const h = document.querySelector('.console-pane .pane-head');
    return { w: innerWidth, over: h.scrollWidth - h.clientWidth,
             tools: Math.round(document.querySelector('.console-pane .head-tools').getBoundingClientRect().width) };
  })()`);
  report.headOverflow.push(row);
}

report.errors = errors;
console.log(JSON.stringify(report, null, 2));

ws.close();
chrome.kill();
