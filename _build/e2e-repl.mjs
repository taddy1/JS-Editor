import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FILE = "file:///C:/Users/Administrator/Desktop/JS%20Editor/js-playground.html";
const PORT = 9431;
const OUT = import.meta.dirname;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + path.join(OUT, ".e2e-repl-profile"),
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
await ev(`localStorage.clear()`);
await send("Page.navigate", { url: FILE });
await sleep(1300);

const report = {};

// ---------- 工具 ----------
async function setEditor(src) {
  await ev(`document.querySelector('.CodeMirror').CodeMirror.setValue(${JSON.stringify(src)})`);
}
async function clickRun() {
  await ev(`document.getElementById('runBtn').click()`);
}
async function runAndWait(src, ms = 1100) {
  await setEditor(src);
  await clickRun();
  await sleep(ms);
}
async function htmlOfBody() {
  return await ev(`document.getElementById('consoleBody').innerText.replace(/\\n+/g, ' | ')`);
}
async function replEval(expr) {
  const before = await ev(`document.getElementById('consoleBody').querySelectorAll('.out-line').length`);
  await ev(`(() => {
    const i = document.getElementById('replInput');
    i.value = ${JSON.stringify(expr)};
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  for (let i = 0; i < 50; i++) {
    await sleep(70);
    const n = await ev(`document.getElementById('consoleBody').querySelectorAll('.out-line').length`);
    if (n >= before + 2) break;
  }
  return await ev(`(() => {
    const rows = [...document.getElementById('consoleBody').querySelectorAll('.out-line.repl')];
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    return {
      mark: last.querySelector('.mark').textContent,
      text: last.querySelector('.body').textContent,
      err: last.classList.contains('err')
    };
  })()`);
}

// ---------- 1. 初始状态 ----------
report.initial = await ev(`(() => {
  const i = document.getElementById('replInput');
  return {
    exists: !!i,
    visible: i.getBoundingClientRect().height > 0,
    placeholder: i.placeholder,
    barH: Math.round(document.querySelector('.repl-bar').getBoundingClientRect().height)
  };
})()`);

// ---------- 2. 没运行就想求值 ----------
await ev(`(() => {
  const i = document.getElementById('replInput');
  i.value = '1+1';
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await sleep(250);
report.beforeRun = await htmlOfBody();

// ---------- 3. 运行主脚本 ----------
await runAndWait([
  'const users = [',
  '  { name: "Ada", age: 36 },',
  '  { name: "Alan", age: 41 },',
  '  { name: "Grace", age: 45 }',
  ']',
  'const { name: first } = users[0]',
  'function greet(n) { return "hi " + n }',
  'let total = users.reduce((a, b) => a + b.age, 0)',
  'console.log("total", total)'
].join('\n'));
report.afterRun = await htmlOfBody();

// ---------- 4. 一串求值 ----------
const cases = [
  'users.length',
  'users[0].name',
  'users.map(u => u.name)',
  'greet("Teddy")',
  'first',
  'total + 1',
  'typeof users',
  'undefined',
  'null',
  '({ a: 1, b: [1, 2] })',
  'document',
  'nope_not_defined',
  'var z = 5',
  'z',
  'z * 2'
];
report.evals = [];
for (const c of cases) {
  const r = await replEval(c);
  report.evals.push({ expr: c, ...r });
}

// ---------- 5. 重复运行同一份代码 ----------
await runAndWait([
  'const users = [{ name: "Ada", age: 36 }]',
  'const { name: first } = users[0]',
  'console.log("run2", users.length)'
].join('\n'), 900);
await clickRun();
await sleep(900);
report.rerun = await htmlOfBody();
report.rerunOk = !/already been declared|重复声明|SyntaxError/i.test(report.rerun);

// ---------- 6. 顶层 await ----------
await runAndWait([
  'const later = await Promise.resolve(42)',
  'console.log("later", later)'
].join('\n'), 900);
report.awaitInRun = await htmlOfBody();
report.awaitRepl = await replEval('later');

// ---------- 7. DOM 保持 + REPL 能查 ----------
await ev(`(() => {
  const t = document.getElementById('mockCode');
  t.value = '<ul class="list"><li class="item">A</li><li class="item">B</li><li class="item">C</li><li class="item">D</li></ul>';
  t.dispatchEvent(new Event('input'));
})()`);
await runAndWait([
  'const items = [...document.querySelectorAll(".item")]',
  'items[0].setAttribute("data-first", "1")',
  'console.log("found", items.length)'
].join('\n'), 1000);
report.domCount = await replEval('document.querySelectorAll(".item").length');
report.domAttr = await replEval('items[0].getAttribute("data-first")');
report.domMutate = await replEval('document.querySelector(".list").children.length = 4');

// ---------- 8. 历史记录 ----------
await ev(`document.getElementById('replInput').focus()`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
await sleep(150);
report.historyUp = await ev(`document.getElementById('replInput').value`);

// ---------- 9. 状态栏与截图 ----------
report.stateBar = await ev(`document.getElementById('stateText').textContent`);

await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(300);
let shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(OUT, "shot-repl-light.png"), Buffer.from(shot.data, "base64"));

await ev(`document.getElementById('themeBtn').click()`);
await sleep(400);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(OUT, "shot-repl-dark.png"), Buffer.from(shot.data, "base64"));

// ---------- 10. 窄屏 ----------
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 860, deviceScaleFactor: 2, mobile: false });
await sleep(400);
report.narrow = await ev(`(() => {
  const bar = document.querySelector('.repl-bar');
  const i = document.getElementById('replInput');
  return {
    barW: Math.round(bar.getBoundingClientRect().width),
    inputW: Math.round(i.getBoundingClientRect().width),
    over: bar.scrollWidth - bar.clientWidth
  };
})()`);
shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(OUT, "shot-repl-700.png"), Buffer.from(shot.data, "base64"));

report.errors = errors;
console.log(JSON.stringify(report, null, 2));

ws.close();
chrome.kill();
