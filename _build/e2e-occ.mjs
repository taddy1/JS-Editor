// 同名标识符高亮的端到端验证
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = "C:/Users/Administrator/Desktop/JS Editor";
const FILE = "file:///" + ROOT.replace(/ /g, "%20") + "/js-playground.html";
const PORT = 9471;
const HERE = import.meta.dirname;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${HERE}/.e2e-occ-profile`,
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
if (!page) { console.error("no page"); process.exit(1); }

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

// 统计 occ 标记（getAllMarks 拿到的是全文，不受视口限制）
const occStats = `(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  const out = [];
  cm.getAllMarks().forEach(m => {
    if (!m.className || m.className.indexOf('cm-occ') !== 0) return;
    const p = m.find();
    if (!p) return;
    out.push({ cls: m.className, line: p.from.line, ch: p.from.ch, to: p.to.ch });
  });
  return out;
})()`;

const DOC = [
  '// users 列表，注释里也提到 users',
  'const users = [',
  '  { name: "Ada", age: 36 },',
  '  { name: "Alan", age: 41 }',
  '];',
  'const usersX = 1;',
  'const $el = null;',
  'users.forEach(function (u) {',
  '  console.log(u.name, users.length, usersX);',
  '});',
  'console.log("users 出现在字符串里的 users");'
].join("\n");

await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue(${JSON.stringify(DOC)});
  cm.setCursor({ line: 1, ch: 7 });
})()`);
await sleep(320);
report.cursorOnly = await ev(occStats);

// 双击（等价于 setSelection 到整个词）
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setSelection({ line: 1, ch: 6 }, { line: 1, ch: 11 });
})()`);
await sleep(320);
report.dblclick = await ev(occStats);

// 选到半个词，应当自动补成整个标识符
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setSelection({ line: 7, ch: 0 }, { line: 7, ch: 3 });
})()`);
await sleep(320);
report.partialSel = await ev(occStats);

// $ 开头的标识符
await ev(`(() => {
  document.querySelector('.CodeMirror').CodeMirror.setCursor({ line: 6, ch: 7 });
})()`);
await sleep(320);
report.dollar = await ev(occStats);

// 中文标识符
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue(['const 用户 = ["甲", "乙"];', '用户.forEach(x => console.log(用户.length, x));', 'console.log("共", 用户.length);'].join('\\n'));
  cm.setCursor({ line: 0, ch: 7 });
})()`);
await sleep(320);
report.chinese = await ev(occStats);

// 光标落在空白处 → 不应有任何标记
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue('var a = 1;\\n\\nvar b = 2;');
  cm.setCursor({ line: 1, ch: 0 });
})()`);
await sleep(320);
report.blank = await ev(occStats);

// 多选/跨行选区 → 不高亮
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue(${JSON.stringify(DOC)});
  cm.setSelection({ line: 1, ch: 6 }, { line: 2, ch: 4 });
})()`);
await sleep(320);
report.multiLine = await ev(occStats);

// 与查找面板共存：打开时应清掉，关闭后恢复
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setCursor({ line: 1, ch: 8 });
})()`);
await sleep(300);
report.beforeSearch = (await ev(occStats)).length;
await ev(`document.getElementById('findBtn').click()`);
await sleep(260);
report.duringSearch = (await ev(occStats)).length;
report.searchYellow = await ev(`document.querySelectorAll('.cm-srch-hit').length`);
await ev(`(() => {
  const f = document.getElementById('srchFind');
  f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
})()`);
await sleep(320);
report.afterSearch = (await ev(occStats)).length;

// 编辑后重算：把 users 改名，原位置应清空
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setCursor({ line: 1, ch: 8 });
})()`);
await sleep(300);
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.replaceRange('members', { line: 1, ch: 6 }, { line: 1, ch: 11 });
})()`);
await sleep(420);
report.afterEdit = (await ev(occStats)).length;

// 性能：800 行、1600 处同名（触及上限）
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  const rows = [];
  for (let i = 0; i < 800; i++) rows.push('x' + i + ' = total + total + ' + i + ';');
  cm.setValue(rows.join('\\n'));
  cm.setCursor({ line: 0, ch: 0 });
})()`);
await sleep(500);
report.bigDoc = await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setCursor({ line: 400, ch: 10 });
  return { before: cm.getAllMarks().filter(m => m.className && m.className.indexOf('cm-occ') === 0).length };
})()`);
await sleep(500);
report.bigDoc.after = await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  return cm.getAllMarks().filter(m => m.className && m.className.indexOf('cm-occ') === 0).length;
})()`);
report.bigDoc.rebuild = await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.getAllMarks().forEach(m => { if (m.className && m.className.indexOf('cm-occ') === 0) m.clear(); });
  const t0 = performance.now();
  cm.setCursor({ line: 700, ch: 10 });
  return new Promise(res => {
    const tick = () => {
      const n = cm.getAllMarks().filter(m => m.className && m.className.indexOf('cm-occ') === 0).length;
      if (n > 0) res({ totalMs: Math.round(performance.now() - t0), marks: n });
      else setTimeout(tick, 8);
    };
    tick();
  });
})()`);

// 截图：1440 浅色
await ev(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  cm.setValue(${JSON.stringify(DOC)});
  cm.setSelection({ line: 1, ch: 6 }, { line: 1, ch: 11 });
  cm.focus();
})()`);
await sleep(400);
let shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(HERE, "shot-occ-light.png"), Buffer.from(shot.data, "base64"));

// 深色
await ev(`document.getElementById('themeBtn').click()`);
await sleep(420);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(HERE, "shot-occ-dark.png"), Buffer.from(shot.data, "base64"));
await ev(`document.getElementById('themeBtn').click()`);
await sleep(200);

// 700px 窄屏
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(350);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(HERE, "shot-occ-700.png"), Buffer.from(shot.data, "base64"));
await send("Emulation.clearDeviceMetricsOverride");

report.errors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
chrome.kill();
