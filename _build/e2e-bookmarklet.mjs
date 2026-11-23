// 端到端：headless Chrome + CDP 验证「转 Bookmark JS」
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = "file:///" + encodeURI(path.join(ROOT, "js-playground.html").replace(/\\/g, "/"));
const PROFILE = path.join(import.meta.dirname, ".e2e-profile");
const PORT = 9339;

fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--window-size=1440,900",
  "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) {}
    await sleep(150);
  }
  throw new Error("Chrome 没起来");
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    errors.push((d.exception && d.exception.description) || d.text);
  }
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
    errors.push(msg.params.entry.text);
  }
};
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Page.navigate", { url: FILE });
await sleep(1500);

const report = {};

// 1. 顶栏是否溢出（多种宽度）
report.overflow = [];
for (const w of [1440, 1360, 1280, 1240, 1180, 1100, 1000, 940, 900, 880, 820, 780, 760, 720, 700, 680]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(120);
  const o = await ev(`(() => {
    const tb = document.querySelector('.topbar');
    const ph = document.querySelector('.pane-head');
    return { w: innerWidth, scroll: tb.scrollWidth, client: tb.clientWidth, over: tb.scrollWidth - tb.clientWidth,
             lastRight: Math.max(...[...tb.querySelectorAll('button,.save-state')].map(n => n.getBoundingClientRect().right)),
             headOver: ph.scrollWidth - ph.clientWidth,
             brandLines: Math.round(document.querySelector('.brand').getBoundingClientRect().height) };
  })()`);
  report.overflow.push(o);
}
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(200);

// 2. 点击按钮，检查弹窗
report.modal = await ev(`(() => {
  document.getElementById('bmBtn').click();
  const v = document.getElementById('bmCode').value;
  return {
    open: document.querySelector('.bm-veil').classList.contains('open'),
    len: v.length,
    head: v.slice(0, 90),
    tail: v.slice(-40),
    oneLine: v.indexOf('\\n') < 0,
    stat: document.getElementById('bmStat').textContent,
    hint: document.getElementById('bmHint').innerText.replace(/\\n/g, ' | '),
    dragHrefLen: document.getElementById('bmDrag').getAttribute('href').length,
    codeScrolled: document.getElementById('bmCode').scrollHeight
  };
})()`);

// 3. 截图（生成的弹窗）
const shot1 = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(import.meta.dirname, "shot-modal.png"), Buffer.from(shot1.data, "base64"));

// 4. 生成一个会改 document.title 的脚本，真的用 javascript: URL 跑一遍
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue([
    '// 综合自检：注释 / ASI / 模板字符串 / 百分号',
    'var n = 1',
    'var m = 2',
    'var t = \\\`a%20b#c\\\`',
    'if (n < m) {',
    '  document.title = ["ok", n + m, t, "100%"].join("|")',
    '} else {',
    '  document.title = "bad"',
    '}'
  ].join('\\n'));
  if (document.querySelector('.bm-veil').classList.contains('open')) document.getElementById('bmClose').click();
  document.getElementById('bmBtn').click();
})()`);
await sleep(300);
const url = await ev(`document.getElementById('bmCode').value`);
report.urlLen = url.length;
report.urlHead = url.slice(0, 160);
await ev(`document.title = 'pending'; location.href = ${JSON.stringify(url)};`);
await sleep(500);
report.afterRun = await ev(`document.title`);
report.modalStillOpen = await ev(`document.querySelector('.bm-veil').classList.contains('open')`);

// 5. 还原：点「还原为代码」
report.restore = await ev(`(() => {
  const before = document.querySelector('.CodeMirror').CodeMirror.getValue();
  document.getElementById('bmRestore').click();
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  return { beforeHead: before.slice(0, 60), after: cm.getValue(), open: document.querySelector('.bm-veil').classList.contains('open') };
})()`);

// 6. 再点按钮（当前内容已是 javascript: 链接 → 应直接还原）
report.toggleBack = await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue(document.getElementById('bmCode').value);
  document.getElementById('bmBtn').click();
  return { isJs: /^\\s*javascript:/i.test(cm.getValue()), len: cm.getValue().length, state: document.getElementById('stateText').textContent };
})()`);

// 7. 语法错误时应拦截
report.syntaxBlock = await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue('function f(){\\n  console.log(1\\n');
  document.getElementById('bmBtn').click();
  return { open: document.querySelector('.bm-veil').classList.contains('open'), state: document.getElementById('stateText').textContent };
})()`);

// 8. 快捷键 Alt+Shift+B、Esc 关闭、IIFE 开关
await ev(`document.querySelector('.CodeMirror').CodeMirror.setValue('var a = 1\\nconsole.log(a)\\n')`);
await ev(`document.querySelector('.CodeMirror').CodeMirror.focus()`);
const keyOpts = { modifiers: 9, key: "B", code: "KeyB", windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 };
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyOpts });
await send("Input.dispatchKeyEvent", { type: "keyUp", ...keyOpts });
await sleep(250);
report.shortcut = await ev(`({
  open: document.querySelector('.bm-veil').classList.contains('open'),
  url: document.getElementById('bmCode').value
})`);

report.wrapOff = await ev(`(() => {
  const wrap = document.getElementById('bmWrap');
  wrap.checked = false;
  wrap.dispatchEvent(new Event('change'));
  const off = document.getElementById('bmCode').value;
  wrap.checked = true;
  wrap.dispatchEvent(new Event('change'));
  const on = document.getElementById('bmCode').value;
  return { offHead: off.slice(0, 40), offTail: off.slice(-20), onTail: on.slice(-20), offLen: off.length, onLen: on.length };
})()`);

// 9. 窄屏（700px）下的弹窗布局
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 620, deviceScaleFactor: 1, mobile: false });
await sleep(200);
const shotNarrow = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(import.meta.dirname, "shot-modal-700.png"), Buffer.from(shotNarrow.data, "base64"));
report.narrow = await ev(`(() => {
  const c = document.querySelector('.bm-card').getBoundingClientRect();
  const ta = document.getElementById('bmCode').getBoundingClientRect();
  return { cardW: Math.round(c.width), cardH: Math.round(c.height), cardRight: Math.round(c.right), vw: innerWidth, taH: Math.round(ta.height) };
})()`);

// 10. Esc 关闭
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(200);
report.escClose = await ev(`document.querySelector('.bm-veil').classList.contains('open')`);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(150);

// 11. 截图
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue('// 深色主题下的弹窗\\nconst list = [1, 2, 3]\\nconst sum = list.reduce((a, b) => a + b, 0)\\nconsole.log(sum)\\n');
  document.getElementById('bmBtn').click();
})()`);
await sleep(200);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(import.meta.dirname, "shot-modal-light.png"), Buffer.from(shot2.data, "base64"));

await ev(`document.getElementById('themeBtn').click()`);
await sleep(300);
const shot3 = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(import.meta.dirname, "shot-modal-dark.png"), Buffer.from(shot3.data, "base64"));

// 12. 大文件性能（1500 行）
report.perf = await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  const lines = [];
  for (let i = 0; i < 250; i++) {
    lines.push('// 第 ' + i + ' 段注释');
    lines.push('function f' + i + '(a, b) {');
    lines.push('  const s = a + b');
    lines.push('  return s > 10 ? s : s * 2');
    lines.push('}');
    lines.push('console.log(f' + i + '(1, 2))');
  }
  cm.setValue(lines.join('\\n'));
  if (document.querySelector('.bm-veil').classList.contains('open')) document.getElementById('bmClose').click();
  const t = performance.now();
  document.getElementById('bmBtn').click();
  return { ms: Math.round(performance.now() - t), lines: cm.lineCount(), urlLen: document.getElementById('bmCode').value.length,
           stat: document.getElementById('bmStat').textContent };
})()`);

// 13. 复制按钮
report.copy = await ev(`(() => {
  document.getElementById('bmCopy').click();
  return { label: document.getElementById('bmCopy').textContent, state: document.getElementById('stateText').textContent };
})()`);
await sleep(200);
report.copyAfter = await ev(`document.getElementById('bmCopy').textContent`);

report.errors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
chrome.kill();
