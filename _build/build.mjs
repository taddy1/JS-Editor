import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cmDir = path.join(here, "node_modules", "codemirror");
const acornDir = path.join(here, "node_modules", "acorn");
const beautifyDir = path.join(here, "node_modules", "js-beautify");
const outPath = path.join(path.dirname(here), "js-playground.html");

const read = (p) => fs.readFileSync(path.join(cmDir, p), "utf8");
const readAcorn = (p) => fs.readFileSync(path.join(acornDir, p), "utf8");
const readBeautify = (p) => fs.readFileSync(path.join(beautifyDir, p), "utf8");

const parts = {
  CM_CSS: read("lib/codemirror.css"),
  HINT_CSS: read("addon/hint/show-hint.css"),
  DIALOG_CSS: read("addon/dialog/dialog.css"),
  FOLDGUTTER_CSS: read("addon/fold/foldgutter.css"),
  CM_JS: read("lib/codemirror.js"),
  MODE_JS: read("mode/javascript/javascript.js"),
  HINT_JS: read("addon/hint/show-hint.js"),
  JSHINT_JS: read("addon/hint/javascript-hint.js"),
  MATCH_JS: read("addon/edit/matchbrackets.js"),
  CLOSE_JS: read("addon/edit/closebrackets.js"),
  ACTIVE_JS: read("addon/selection/active-line.js"),
  COMMENT_JS: read("addon/comment/comment.js"),
  SEARCHCURSOR_JS: read("addon/search/searchcursor.js"),
  DIALOG_JS: read("addon/dialog/dialog.js"),
  SEARCH_JS: read("addon/search/search.js"),
  JUMP_JS: read("addon/search/jump-to-line.js"),
  FOLDCODE_JS: read("addon/fold/foldcode.js"),
  BRACEFOLD_JS: read("addon/fold/brace-fold.js"),
  COMMENTFOLD_JS: read("addon/fold/comment-fold.js"),
  FOLDGUTTER_JS: read("addon/fold/foldgutter.js"),
  ACORN_JS: readAcorn("dist/acorn.js"),
  BEAUTIFY_JS: readBeautify("js/lib/beautify.js"),
};

let html = fs.readFileSync(path.join(here, "app.template.html"), "utf8");

for (const [key, value] of Object.entries(parts)) {
  const token = `/*__${key}__*/`;
  if (!html.includes(token)) {
    throw new Error(`missing placeholder: ${token}`);
  }
  html = html.replace(token, () => value);
}

const leftover = html.match(/\/\*__[A-Z_]+__\*\//g);
if (leftover) throw new Error(`unreplaced: ${leftover.join(", ")}`);

fs.writeFileSync(outPath, html, "utf8");
console.log("written:", outPath);
console.log("bytes:", Buffer.byteLength(html, "utf8"));
