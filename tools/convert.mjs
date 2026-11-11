// Builds the LiaScript version of "Eloquent JavaScript" from the original
// sources of the book.
//
//   git clone --depth 1 https://github.com/marijnh/Eloquent-JavaScript.git .cache/original
//   node tools/convert.mjs
//
// Writes README.md (the whole book as one LiaScript document), code/
// (chapter code and helper files, code/chapters.json for the sandbox),
// img/, example/ and css/. The text stays word for word; only the markup
// of the original build system is translated:
//
//   {{index …}}, ((term))      dropped / reduced to the term
//   {{quote}}, {{figure}}       blockquote, image
//   {{hint}}                    <details>
//   {{if interactive|html}}     kept;  {{if book|tex|commercial}} dropped
//   [text](chapter#id)          link to the slide inside this document
//   ``` blocks                  runnable through the ejs-sandbox template
import * as fs from "node:fs"
import * as path from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
import {createRequire} from "node:module"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = path.join(root, ".cache/original")
const acorn = require(path.join(root, "lia-templates/ejs-sandbox/acorn.js"))
const PJSON = await import(pathToFileURL(path.join(src, "src/pseudo_json.mjs")).href)

const DEFINED = ["interactive", "html"]       // variants of the text that are kept
const LAST_RUNNABLE = 19                      // chapters 20 and 21 need Node.js

const files = fs.readdirSync(src).filter(f => /^\d{2}_\w+\.md$/.test(f)).sort()
const chapters = files.map(f => ({
  file: f,
  key: f.replace(/\.md$/, ""),
  name: /^\d{2}_(\w+)\.md$/.exec(f)[1],
  number: Number(f.slice(0, 2)),
  input: fs.readFileSync(path.join(src, f), "utf8")
}))
const byName = Object.fromEntries(chapters.map(c => [c.name, c]))
const warnings = []
const warn = msg => warnings.push(msg)

// ----------------------------------------------------------------- varify
// Port of src/varify.mjs: top-level declarations become globals, modules
// become plain scripts, so a chapter file can be loaded into a sandbox.

function varify(code) {
  let ast
  try { ast = acorn.parse(code, {sourceType: "module", ecmaVersion: "latest"}) }
  catch (_) { return code }
  let patches = []
  ast.body.forEach(node => {
    if (node.type == "VariableDeclaration" && node.kind != "var") {
      patches.push({from: node.start, to: node.start + node.kind.length, text: "var"})
    } else if (node.type == "ClassDeclaration") {
      patches.push({from: node.start, to: node.start, text: "var " + node.id.name + " = "})
    } else if (node.type == "ImportDeclaration") {
      let req = "require(" + node.source.raw + ")", text
      if (node.specifiers.length == 0) {
        text = req
      } else if (node.specifiers.length > 1 || node.specifiers[0].type == "ImportDefaultSpecifier") {
        let name = "m_" + node.source.value.replace(/\W+/g, "_") + "__"
        text = "var " + name + " = " + req
        node.specifiers.forEach(spec => {
          if (spec.type == "ImportDefaultSpecifier")
            text += ", " + spec.local.name + " = " + name + ".default || " + name
          else
            text += ", " + spec.local.name + " = " + name + "." + spec.imported.name
        })
      } else {
        text = "var "
        node.specifiers.forEach(spec => {
          if (spec.type == "ImportNamespaceSpecifier") text += spec.local.name + " = " + req
          else text += spec.local.name + " = " + req + "." + spec.imported.name
        })
      }
      patches.push({from: node.start, to: node.end, text: text + ";"})
    } else if (node.type == "ExportNamedDeclaration") {
      if (node.source || !node.declaration) patches.push({from: node.start, to: node.end, text: ""})
      else patches.push({from: node.start, to: node.declaration.start, text: ""})
    } else if (node.type == "ExportDefaultDeclaration") {
      if (/Declaration/.test(node.declaration.type)) {
        patches.push({from: node.start, to: node.declaration.start, text: ""})
      } else {
        patches.push({from: node.start, to: node.declaration.start, text: ";("},
                     {from: node.declaration.end, text: ")"})
      }
    } else if (node.type == "ExportAllDeclaration") {
      patches.push({from: node.start, to: node.end, text: ""})
    }
  })
  patches.sort((a, b) => a.from - b.from || (a.to || a.from) - (b.to || b.from))
  let out = "", pos = 0
  patches.forEach(({from, to, text}) => {
    out += code.slice(pos, from) + text
    pos = to == null ? from : to
  })
  return out + code.slice(pos)
}

// ------------------------------------------------------------- build code
// Port of src/build_code.mjs: collects the blocks marked includeCode into
// the code file of the chapter (or into the file named with ">").

function buildCode(chapter) {
  let included = /\n```(.*?\bincludeCode:.*)\n([^]*?\n)```/g, m
  let out = Object.create(null)
  let defaultFile = "code/chapter/" + chapter.key + ".js"
  while (m = included.exec(chapter.input)) {
    let [_, params, snippet] = m, directive = String(PJSON.parse(params).includeCode)
    let file = defaultFile, f
    if (f = directive.match(/(?:\s|^)>(\S+)/)) file = f[1]
    snippet = snippet.replace(/(\n|^)\s*\/\/ →.*\n/g, "$1")
    if (!/\.mjs$/.test(file)) snippet = varify(snippet)
    if (directive.indexOf("strip_log") > -1)
      snippet = snippet.replace(/(\n|^)\s*console\.log\(.*\);\n/g, "$1")
    if (f = directive.match(/top_lines:\s*(\d+)/))
      snippet = snippet.split("\n").slice(0, Number(f[1])).join("\n") + "\n"
    ;(out[file] || (out[file] = [])).push(snippet)
  }
  return out
}

// ----------------------------------------------------------------- inline

const CODE_OPEN = "", CODE_CLOSE = "", RAW_OPEN = "", RAW_CLOSE = ""

// Finds the "]" that closes the "[" at `open`.
function closingBracket(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    let ch = text[i]
    if (ch == "\\") i++
    else if (ch == "[") depth++
    else if (ch == "]") { depth--; if (depth == 0) return i }
  }
  return -1
}

// [text]{if x}, [text]{keyname}, [text]{latex}
function inlineMeta(text) {
  let out = ""
  for (let pos = 0; pos < text.length;) {
    let open = text.indexOf("[", pos)
    if (open < 0) { out += text.slice(pos); break }
    let close = closingBracket(text, open)
    let m = close < 0 ? null : /^\{(if|keyname|latex)\s*(\w*)\}/.exec(text.slice(close + 1))
    if (!m) { out += text.slice(pos, open + 1); pos = open + 1; continue }
    out += text.slice(pos, open)
    let inner = inlineMeta(text.slice(open + 1, close))
    if (m[1] == "keyname") out += RAW_OPEN + "<kbd>" + RAW_CLOSE + inner + RAW_OPEN + "</kbd>" + RAW_CLOSE
    else if (m[1] == "if" && DEFINED.includes(m[2])) out += inner
    pos = close + 1 + m[0].length
  }
  return out
}

function smartQuotes(text) {
  const before = `(?<=[\\w.,!?)${CODE_CLOSE}${RAW_CLOSE}][\\]*]*)`
  const after = `(?=[\\[*]*[\\w${CODE_OPEN}])`
  return text
    .replace(new RegExp(before + "'", "g"), "’")
    .replace(new RegExp("'" + after, "g"), "‘")
    .replace(new RegExp(before + '"', "g"), "”")
    .replace(new RegExp('"' + after, "g"), "“")
}

// Translates one line of running text. `ctx.link(chapter, id)` returns the
// placeholder of an internal link.
function inline(text, ctx) {
  let stash = []
  let keep = (s, open, close) => { stash.push(s); return open + (stash.length - 1) + close }
  // code spans stay as they are
  text = text.replace(/(`+)([^]*?)\1/g, m => keep(m, CODE_OPEN, CODE_CLOSE))
  text = inlineMeta(text)
  // index terms: ((term)) → term
  text = text.replace(/\(\(((?:[^()]|\((?!\())*?)\)\)/g, "$1")
  // links
  let out = ""
  for (let pos = 0; pos < text.length;) {
    let open = text.indexOf("[", pos)
    if (open < 0) { out += text.slice(pos); break }
    let close = closingBracket(text, open)
    let m = close < 0 ? null : /^\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/.exec(text.slice(close + 1))
    if (!m) { out += text.slice(pos, open + 1); pos = open + 1; continue }
    let label = text.slice(open + 1, close), href = m[1]
    let chap = /^(\w+)(?:#(.*))?$/.exec(href)
    if (chap && byName[chap[1]]) {
      label = label.replace(/\?/g, String(byName[chap[1]].number))
      href = ctx.link(chap[1], chap[2])
    } else if (chap && !/^https?:/.test(href)) {
      warn(`${ctx.chapter.file}: link target "${href}" is not a chapter`)
    }
    out += text.slice(pos, open) + "[" + label + "]" + keep("(" + href + ")", RAW_OPEN, RAW_CLOSE)
    pos = close + 1 + m[0].length
  }
  text = out
  // inline HTML stays as it is
  text = text.replace(/<\/?[a-zA-Z][^<>]*>/g, m => keep(m, RAW_OPEN, RAW_CLOSE))
  text = smartQuotes(text)
  // sub- and superscript
  text = text.replace(/~([^\s~]+)~/g, "<sub>$1</sub>").replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>")
  // a single dollar sign must not start a formula
  text = text.replace(/\$/g, "\\$")
  let restore = s => s.replace(/[](\d+)[]/g, (_, n) => restore(stash[Number(n)]))
  return restore(text)
}

// ----------------------------------------------------------------- blocks

function parseArgs(text, where) {
  text = text.trim()
  if (!text) return {}
  try { return PJSON.parse(text) }
  catch (e) { warn(`${where}: cannot read "${text}"`); return {} }
}

// Line index of the closer of a block directive that opens at `start`.
function blockEnd(lines, start, tag) {
  let open = new RegExp("^\\{\\{" + tag + "(\\s|$)"), close = tag + "}}", depth = 0
  for (let i = start + 1; i < lines.length; i++) {
    if (open.test(lines[i]) && !/\}\}\s*$/.test(lines[i])) depth++
    else if (lines[i] == close) { if (depth) depth--; else return i }
  }
  throw new Error("Unterminated {{" + tag + " block")
}

class Book {
  constructor() {
    this.out = []
    this.slide = 0
    this.chapterSlide = {}
    this.ids = {}
    this.manifest = {}
    this.runnable = 0
  }

  heading(level, text) {
    this.slide++
    this.push("#".repeat(level) + " " + text)
  }

  push(...blocks) {
    for (let block of blocks) this.out.push(block)
  }

  link(chapter, id) {
    return "" + chapter + (id ? "#" + id : "") + ""
  }

  resolveLinks(text) {
    return text.replace(/([^#]+)(?:#([^]*))?/g, (_, chapter, id) => {
      let slide = id != null ? (this.ids[chapter] || {})[id] : null
      if (id != null && slide == null) warn(`link to ${chapter}#${id}: no such id`)
      return "#" + (slide || this.chapterSlide[chapter])
    })
  }

  convertChapter(chapter) {
    this.chapter = chapter
    this.ids[chapter.name] = {}
    this.manifest[chapter.key] = {load: [], sandboxes: {}}
    this.ctx = {chapter, link: (c, id) => this.link(c, id)}
    this.blocks(chapter.input.split("\n"), 0)
  }

  // Converts a run of source lines; `quote` is true inside a blockquote.
  blocks(lines) {
    let chapter = this.chapter, pendingId = null, tableNext = false
    let para = []
    let flush = () => {
      if (!para.length) return
      this.push(para.map(l => inline(l, this.ctx)).join("\n"))
      para = []
    }
    let takeId = () => {
      if (pendingId == null) return
      this.ids[chapter.name][pendingId] = Math.max(this.slide, 1)
      pendingId = null
    }

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i], m

      if (m = /^```(.*)$/.exec(line)) {
        flush()
        let end = i + 1
        while (end < lines.length && !/^```\s*$/.test(lines[end])) end++
        takeId()
        this.code(parseArgs(m[1], chapter.file + ":" + (i + 1)), lines.slice(i + 1, end).join("\n"))
        i = end
        continue
      }

      if (m = /^\{\{(\w+)\s*(.*?)\s*$/.exec(line)) {
        flush()
        let tag = m[1], single = /^(.*)\}\}$/.exec(m[2])
        if (single) {
          let args = single[1]
          if (tag == "meta") {
            let meta = parseArgs(args, chapter.file)
            this.manifest[chapter.key].load = meta.load_files || []
          } else if (tag == "id") {
            pendingId = args.trim().replace(/^"|"$/g, "")
          } else if (tag == "figure") {
            takeId()
            let fig = parseArgs(args, chapter.file + ":" + (i + 1))
            this.push(`![${fig.alt.replace(/([\[\]])/g, "\\$1")}](${fig.url})`)
          } else if (tag == "table") {
            tableNext = true
          } else if (tag != "index" && tag != "indexsee") {
            warn(`${chapter.file}:${i + 1}: unknown directive {{${tag}`)
          }
          continue
        }
        let end = blockEnd(lines, i, tag), inner = lines.slice(i + 1, end)
        if (tag == "if") {
          if (DEFINED.includes(m[2].trim())) {
            takeId()
            this.blocks(inner)
          }
        } else if (tag == "quote") {
          takeId()
          this.quote(parseArgs(m[2], chapter.file), inner)
        } else if (tag == "hint") {
          this.push("<details>", "<summary>Display hints...</summary>")
          this.blocks(inner)
          this.push("</details>")
        } else {
          warn(`${chapter.file}:${i + 1}: unknown block {{${tag}`)
        }
        i = end
        continue
      }

      if (m = /^(#+)\s+(.*)$/.exec(line)) {
        flush()
        let level = m[1].length + 1
        this.heading(level, inline(m[2], this.ctx))
        if (level == 2) this.chapterSlide[chapter.name] = this.slide
        takeId()
        continue
      }

      if (/^\|/.test(line)) {
        flush()
        let rows = []
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++])
        i--
        takeId()
        this.table(rows)
        tableNext = false
        continue
      }

      if (!/\S/.test(line)) { flush(); continue }

      if (/^<\w/.test(line) && !para.length) {
        takeId()
        this.push(line)
        continue
      }

      if (!para.length) takeId()
      para.push(line)
    }
    flush()
    return pendingId
  }

  quote(args, lines) {
    let saved = this.out
    this.out = []
    this.blocks(lines)
    let body = this.out.join("\n\n")
    this.out = saved
    let text = body.split("\n").map(l => l ? "> " + l : ">").join("\n")
    if (args.author)
      text += "\n>\n> -- " + inline(args.author, this.ctx) + (args.title ? ", _" + inline(args.title, this.ctx) + "_" : "")
    this.push(text)
  }

  table(rows) {
    let cells = rows.map(row => {
      let m, re = /((?:[^`|]|`.*?`)+)\|?/g, out = []
      row = row.slice(1)
      while (m = re.exec(row)) out.push(inline(m[1].trim(), this.ctx).replace(/\|/g, "\\|"))
      return out
    })
    let width = Math.max(...cells.map(r => r.length))
    let line = r => "| " + Array.from({length: width}, (_, i) => r[i] || "").join(" | ") + " |"
    this.push('<!-- data-type="none" -->\n' + cells.map(line).join("\n"))
  }

  code(params, content) {
    let chapter = this.chapter
    if (params.hidden) return
    let lang = params.lang == null ? "javascript" : String(params.lang)
    let fence = lang == "null" ? "text" : lang
    let block = "``` " + fence + "\n" + content + "\n```"
    let sandbox = params.sandbox == null ? "null" : String(params.sandbox)
    if (lang == "html" && sandbox != "null") this.manifest[chapter.key].sandboxes[sandbox] = content
    if ((lang == "javascript" || lang == "html") && chapter.number <= LAST_RUNNABLE) {
      let flags = []
      if (/\bexpr\b/.test(String(params.meta || ""))) flags.push("expr")
      if (params.focus) flags.push("focus")
      block += `\n@EJS.${lang == "html" ? "html" : "js"}(${chapter.key},${sandbox},${flags.join(" ") || "-"})`
      this.runnable++
    }
    this.push(block)
  }
}

// ------------------------------------------------------------------- main

// The look of the book: fonts and colors of the original website as a
// LiaScript theme. tools/theme-header.txt is built from tools/theme.json
// (skill liascript-theming: build_theme.py tools/theme.json > tools/theme-header.txt).
import {readFileSync as readTheme, existsSync as hasTheme} from "node:fs"
const themeFile = new URL("./theme-header.txt", import.meta.url)
const theme = hasTheme(themeFile) ? readTheme(themeFile, "utf8").trim() + "\n\n" : ""

const header = `<!--
author:   Marijn Haverbeke

version:  4.0.0

language: en

narrator: US English Female

comment:  This is a book about JavaScript, programming, and the wonders of the digital. You can read it online here, or buy your own [paperback copy](https://nostarch.com/eloquent-javascript-4th-edition).

logo:     img/social-logo.jpg

import:   ./lia-templates/ejs-sandbox/README.md

${theme}-->

![Banner with the title "Eloquent JavaScript, Fourth Edition, Marijn Haverbeke" and an ink drawing of a bird with spread wings on a yellow background](img/social-logo.jpg)

[![LiaScript](https://raw.githubusercontent.com/LiaScript/LiaScript/master/badges/course.svg)](https://liascript.github.io/course/?https://raw.githubusercontent.com/LiaPress/Eloquent-JavaScript/main/README.md)

[![LiveEditor](https://raw.githubusercontent.com/LiaScript/LiaScript/refs/heads/development/badges/edit.svg)](https://liascript.github.io/LiveEditor/?/show/file/https://raw.githubusercontent.com/LiaPress/Eloquent-JavaScript/main/README.md)

> **This is a port, not a new book.** It is the book
> [**Eloquent JavaScript**, 4th edition](https://eloquentjavascript.net/) by **Marijn Haverbeke**
> ([source on GitHub](https://github.com/marijnh/Eloquent-JavaScript)), converted to
> [LiaScript](https://liascript.github.io). The text is unchanged – the port keeps the
> book interactive: every example of the introduction and of chapters 1 to 19 can be changed
> and run right in the browser, in a sandbox ported from the website of the book
> (the two Node.js chapters need Node.js on your own computer).
> To read the original, go to [eloquentjavascript.net](https://eloquentjavascript.net/).
> This port is not endorsed by Marijn Haverbeke.
> Licence: text and images [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/),
> code [MIT](code/LICENSE) – see [LICENSE.md](LICENSE.md).

# Eloquent JavaScript

![Cover image](img/cover.jpg)

**4th edition (2024)**

This is a book about JavaScript, programming, and the wonders of the digital. You can read it online here, or buy your own [paperback copy](https://nostarch.com/eloquent-javascript-4th-edition).

Written by Marijn Haverbeke.

Licensed under a [Creative Commons attribution-noncommercial license](https://creativecommons.org/licenses/by-nc/3.0/). All code in this book may also be considered licensed under an [MIT license](https://eloquentjavascript.net/code/LICENSE).

Illustrations by various artists: Cover by [Péchane Sumi-e](http://www.pechane.com/). Chapter illustrations by [Madalina Tantareanu](http://madalinatantareanu.com/). Pixel art in Chapters 7 and 16 by Antonio Perdomo Pastor. Regular expression diagrams in Chapter 9 generated with [regexper.com](https://regexper.com) by Jeff Avallone. Game concept for Chapter 16 by [Thomas Palef](http://lessmilk.com).

**About this version.** This is an adaptation of the book for [LiaScript](https://liascript.github.io), made by Andre Dietrich in November 2026 from the [sources of the fourth edition](https://github.com/marijnh/Eloquent-JavaScript). It is not the original and is not endorsed by the author. The text of the book is unchanged. What was changed:

- All chapters are in one document, and links between chapters point into this document.
- Index marks and the passages written only for the printed book are left out; the passages written for the website are kept.
- The code examples run in a sandbox ported from the website of the book. Chapters 20 and 21 need Node.js and cannot be run here.
- An example is run with the button below its block. Where the text says that examples run by clicking them, it describes the original website.
- Colors and layout follow the stylesheet of the book's website. Its two web fonts, Cinzel and PT Mono, are not used; the fonts of the reader's system take their place.
- The course logo and social preview are AI-assisted adaptations of the original cover by Péchane Sumi-e, recomposed into a landscape banner.
- In the helper file \`code/animatevillage.js\`, an image path was changed and two lines that only matter on the original website were removed.

This version is published under the same licenses as the original: text and images under the [Creative Commons attribution-noncommercial license](https://creativecommons.org/licenses/by-nc/3.0/), code under the [MIT license](https://eloquentjavascript.net/code/LICENSE). See [LICENSE.md](LICENSE.md).`

const book = new Book()
book.slide = 1
book.push(header)
for (let chapter of chapters) book.convertChapter(chapter)
let text = book.resolveLinks(book.out.join("\n\n")) + "\n"
fs.writeFileSync(path.join(root, "README.md"), text)

// code files
function write(rel, content) {
  let file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, content)
}
function copy(from, to) {
  fs.cpSync(path.join(src, from), path.join(root, to), {recursive: true, dereference: true})
}
for (let chapter of chapters) {
  let built = buildCode(chapter)
  for (let file in built) write(file, built[file].join("\n"))
}
for (let name of fs.readdirSync(path.join(src, "code")))
  if (/\.(js|mjs)$/.test(name) || name == "LICENSE") copy("code/" + name, "code/" + name)
copy("code/skillsharing", "code/skillsharing")
// The robot animation draws below the block, into the page of the course;
// there, image paths must start at the folder of the course. Two lines that
// only matter on the original website (a path test and a debug message) go.
{
  let file = path.join(root, "code/animatevillage.js"), text = fs.readFileSync(file, "utf8")
  let patched = text
    .replace('this.imgPath = "img/"', 'this.imgPath = ((window.__sandbox && window.__sandbox.root) || "") + "img/"')
    .replace(/\n *if \(\/\\\/code\(\$\|\\\/\)\/\.test\(outer\.ownerDocument\.defaultView\.location\)\) this\.imgPath = "\.\.\/" \+ this\.imgPath/, "")
    .replace(/\n *console\.log\(outer\.ownerDocument\.defaultView\.location\.toString\(\).*/, "")
  if (patched.split("\n").length != text.split("\n").length - 2 || patched.indexOf("__sandbox.root") < 0)
    warn("code/animatevillage.js: the path patch did not apply as expected")
  fs.writeFileSync(file, patched)
}
copy("img", "img")
copy("html/example", "example")
copy("html/css/game.css", "css/game.css")
copy("html/css/paint.css", "css/paint.css")

// chapter files that the manifest names must exist
for (let key in book.manifest) {
  let entry = book.manifest[key]
  entry.load = entry.load.filter(file => {
    if (fs.existsSync(path.join(root, file))) return true
    warn(`${key}: load file ${file} does not exist`)
    return false
  })
}
write("code/chapters.json", JSON.stringify(book.manifest, null, 1) + "\n")

console.log(`README.md: ${chapters.length} chapters, ${book.slide} slides, ${book.runnable} runnable blocks, ${text.length} characters`)
if (warnings.length) console.log("Warnings:\n- " + warnings.join("\n- "))
