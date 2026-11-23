// 单元测试：从模板里抽出 bookmarklet 相关函数，在 Node 里跑对拍
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const tpl = fs.readFileSync(path.join(__dirname, "app.template.html"), "utf8");
const startMark = "/* ============ 转 Bookmark JS ============ */";
const endMark = "  var bmVeil = document.createElement";
const s = tpl.indexOf(startMark);
const e = tpl.indexOf(endMark, s);
if (s < 0 || e < 0) throw new Error("找不到代码块");
let block = tpl.slice(s + startMark.length, e);

// 依赖：isWordChar / needSpace 来自压缩功能
const depS = tpl.indexOf("function isWordChar");
const depE = tpl.indexOf("// 这些 token 可以结束一条语句", depS);
const deps = tpl.slice(depS, depE);

const sandbox = { acorn, console };
global.window = global.window || {};
try {
  global.window.js_beautify = require("js-beautify").js;
} catch (e) { console.log("（未加载 js-beautify，还原后不排版）"); }
const fn = new Function("acorn", deps + block + "\nreturn { bmBuild, bmUnwrap, bmEsc, bmDecode };");
const api = fn(acorn);

function decodeUrl(url) {
  let t = url.replace(/^javascript:/, "");
  t = api.bmDecode(t);
  t = t.replace(/;?\s*void\s+0\s*;?\s*$/, "");
  const head = /^\s*\(\s*function\s*\(\s*\)\s*\{/;
  const tail = /\}\s*\)\s*\(\s*\)\s*;?\s*$/;
  if (head.test(t) && tail.test(t)) t = t.replace(head, "").replace(tail, "");
  return t;
}
function canon(n) {
  if (!n || typeof n !== "object") return typeof n === "bigint" ? n.toString() : n;
  if (Array.isArray(n)) return n.map(canon);
  const o = {};
  for (const k in n) {
    if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
    const v = n[k];
    o[k] = v && typeof v === "object" ? canon(v) : typeof v === "bigint" ? v.toString() : v;
  }
  return o;
}
function parse(code) {
  try {
    return acorn.parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
  } catch (err) { return { __err: err.message }; }
}

const cases = {
  "基础": `const a = 1;\nconsole.log(a);`,
  "ASI 两语句": `var a = 1\nvar b = 2\nconsole.log(a + b)`,
  "ASI 括号续行(不能补分号)": `var x = 5\n(function(){ console.log("iife") })()`,
  "ASI 数组续行(不能补分号)": `var y = {a:1}\n;[1,2].forEach(n => console.log(n))`,
  "return 换行": `function f(){\n  return\n  1\n}\nconsole.log(f())`,
  "自增续行": `var a = 1\nvar b = a\n++b\nconsole.log(a, b)`,
  "do-while": `var i = 0\ndo {\n  i++\n} while (i < 3)\nconsole.log(i)`,
  "行注释": `// 说明\nvar a = 1 // 行尾注释\nconsole.log(a) // 结尾`,
  "注释里带 */": `// 奇怪的 */ 注释\nvar a = 2;\nconsole.log(a)`,
  "块注释多行": `/* 多行\n   注释 */\nvar a = 3;\nconsole.log(a)`,
  "模板字符串换行": "var s = `第一行\n第二行`;\nconsole.log(s.length)",
  "百分号井号中文": `var s = "100% #标签 中文";\nconsole.log(s)`,
  "正则里的百分号": `var re = /%20/g;\nconsole.log("a b".replace(re, "_"))`,
  "class 字段": `class A {\n  x = 1\n  y = 2\n}\nconsole.log(new A().y)`,
  "if-else": `var n = 2\nif (n > 1) {\n  console.log("big")\n} else {\n  console.log("small")\n}`,
  "注释在语句之间": `var a = 1\n// 中间注释\nvar b = 2\nconsole.log(a + b)`,
  "注释打断 ASI": `var a = 1 // 行尾\n// 独立注释\nvar b = 2\nconsole.log(a + b)`,
  "switch": `var k = 2\nswitch (k) {\n  case 1:\n    console.log(1)\n    break\n  default:\n    console.log("other")\n}`,
  "箭头函数返回对象": `var f = () => ({a: 1})\nconsole.log(f().a)`,
  "字符串含 # 和 %": `console.log("a#b%20c")`,
  "for 循环": `var sum = 0\nfor (var i = 0; i < 3; i++) {\n  sum += i\n}\nconsole.log(sum)`,
  "try-catch": `try {\n  throw new Error("x")\n} catch (e) {\n  console.log(e.message)\n} finally {\n  console.log("done")\n}`
};

let fail = 0;
for (const [name, code] of Object.entries(cases)) {
  const r = api.bmBuild(code, true);
  if (r.error) { console.log(`✗ ${name} → 生成失败: ${r.error}`); fail++; continue; }
  const url = r.url;
  const single = url.indexOf("\n") < 0 && url.indexOf("\r") < 0;
  const body = decodeUrl(url);
  const A = parse(code);
  const B = parse(body);
  const same = !A.__err && !B.__err && JSON.stringify(canon(A)) === JSON.stringify(canon(B));
  const line1 = url.length;
  console.log(`${same && single ? "✓" : "✗"} ${name}${r.lossy ? " [保守模式]" : ""} ${line1}B${single ? "" : " ⚠多行"}`);
  if (!same || !single) {
    fail++;
    if (B.__err) console.log("   重解析出错:", B.__err);
    console.log("   生成:", url.slice(0, 400));
    console.log("   还原:", body.slice(0, 400));
  }
}

// 往返测试：转出去再还原，看看是否还能跑
console.log("\n--- 往返（url → 代码） ---");
for (const name of ["基础", "行注释", "注释打断 ASI", "模板字符串换行"]) {
  const r = api.bmBuild(cases[name], true);
  const back = api.bmUnwrap(r.url);
  const ok = !parse(back).__err;
  console.log(`${ok ? "✓" : "✗"} ${name}:\n${back.split("\n").map(l => "    " + l).join("\n")}`);
  if (!ok) fail++;
}

// 已经被转过的内容不能再转
const twice = api.bmBuild(api.bmBuild(cases["基础"], true).url, true);
console.log("\n二次转换模块语法检查:", twice.error || (twice.url.length + " 字符"));

console.log(fail ? `\n失败 ${fail} 项` : "\n全部通过");
process.exit(fail ? 1 : 0);
