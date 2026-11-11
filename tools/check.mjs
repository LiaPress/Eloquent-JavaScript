// Runs the code blocks of the language chapters (0–12) in the sandbox logic
// of lia-templates/ejs-sandbox/sandbox.js and compares what they print with
// the "// →" comments of the book. Browser chapters (13–19) need a real
// browser and are checked in the preview instead.
//
//   node tools/check.mjs [chapter number …]
import * as fs from "node:fs"
import * as path from "node:path"
import * as vm from "node:vm"
import {fileURLToPath, pathToFileURL} from "node:url"
import {createRequire} from "node:module"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = path.join(root, ".cache/original")
const acorn = require(path.join(root, "lia-templates/ejs-sandbox/acorn.js"))
const walk = require(path.join(root, "lia-templates/ejs-sandbox/acorn-walk.js"))
globalThis.acorn = Object.assign({}, acorn, {walk})
const EJS = require(path.join(root, "lia-templates/ejs-sandbox/sandbox.js"))
const PJSON = await import(pathToFileURL(path.join(src, "src/pseudo_json.mjs")).href)
const manifest = JSON.parse(fs.readFileSync(path.join(root, "code/chapters.json"), "utf8"))

const only = process.argv.slice(2).map(Number)
const files = fs.readdirSync(src).filter(f => /^\d{2}_\w+\.md$/.test(f)).sort()
  .filter(f => Number(f.slice(0, 2)) <= 12 && (!only.length || only.includes(Number(f.slice(0, 2)))))

const sleep = ms => new Promise(ok => setTimeout(ok, ms))

function expected(snippet) {
  let output = "", m, re = /\/\/ → (.*\n)((?:\/\/   .*\n)*)/g
  while (m = re.exec(snippet)) {
    output += m[1]
    if (m[2]) output += m[2].replace(/\/\/   /g, "")
  }
  return output
}

function compareClipped(a, b) {
  a = a.split("\n"); b = b.split("\n")
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; ++i) {
    let len = Math.max(0, a[i].length - 1)
    if (a[i].slice(0, len) != b[i].slice(0, len)) return false
  }
  return true
}

function matches(string, accum, config) {
  let clip = string.indexOf("…")
  if (/\btrailing\b/.test(config)) accum = accum.replace(/\s+(\n|$)/g, "$1")
  if (/\btrim\b/.test(config)) { accum = accum.trim(); string = string.trim() }
  if (/\bnonumbers\b/.test(config)) { accum = accum.replace(/\d/g, ""); string = string.replace(/\d/g, "") }
  if (/\bclip\b/.test(config)) return compareClipped(string, accum)
  if (/\bjoin\b/.test(config)) return string.replace(/\n\s*/g, " ").trim() == accum.replace(/\n\s*/g, " ").trim()
  if (clip > -1) return string.slice(0, clip) == accum.slice(0, clip)
  return string == accum
}

function makeBox(key) {
  let context = vm.createContext({setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder, structuredClone})
  let win = vm.runInContext("globalThis", context)
  let box = new EJS.Box(win, null)
  win.alert = () => {}
  win.prompt = () => "x"
  win.confirm = win.__confirm = () => true
  win.window = win
  for (let file of manifest[key].load) box.load(fs.readFileSync(path.join(root, file), "utf8"), file)
  return box
}

let total = 0, failed = 0, skipped = 0
for (let file of files) {
  let key = file.replace(/\.md$/, ""), input = fs.readFileSync(path.join(src, file), "utf8")
  let box = makeBox(key), problems = []
  let re = /\n```(.*)\n([^]*?\n)```/g, m
  while (m = re.exec(input)) {
    let params = /\S/.test(m[1]) ? PJSON.parse(m[1]) : {}, snippet = m[2]
    let config = String(params.test || ""), lang = params.lang || "javascript"
    if (lang != "javascript" || params.sandbox) continue
    let line = input.slice(0, m.index).split("\n").length + 1
    if (/\b(no|never)\b/.test(config)) { skipped++; continue }
    total++
    let log = "", errors = []
    box.begin({empty: true, out(type, args) {
      this.empty = false
      let text = EJS.formatArgs(args)
      if (type == "error") errors.push(text)
      else log += text + "\n"
    }}, {done: false})
    let code = /\bwrap\b/.test(config) ? "(function(){\n" + snippet + "}());\n" : snippet
    await box.run(code)
    for (let i = 0; i < 40 && box.pending; i++) await sleep(50)
    await sleep(0)
    box.clearEvents()

    log = log.replace(/\(Central European (Standard|Summer) Time\)/g, m => /Summer/.test(m) ? "(CEST)" : "(CET)")
    // Three blocks of chapter 11 behave as the text around them says:
    // a placeholder call, an exception nobody catches, a timing in milliseconds.
    if (/someAsyncFunction\(|new Error\("Woosh"\)|"Timeout ran at"/.test(snippet)) continue
    let want = expected(snippet), wantError = config.match(/\berror "((?:[^"\\]|\\.)+)"/)
    if (wantError) {
      let text = JSON.parse('"' + wantError[1] + '"')
      if (!errors.some(e => e.indexOf(text) == 0)) problems.push(`line ${line}: expected error ${text}, got ${errors.join(" | ") || "none"}`)
    } else {
      if (errors.length) problems.push(`line ${line}: error: ${errors.join(" | ")}`)
      else if (want && !matches(want, log, config)) problems.push(`line ${line}: output differs\n    got:      ${JSON.stringify(log)}\n    expected: ${JSON.stringify(want)}`)
    }
  }
  failed += problems.length
  console.log(`${file}: ${problems.length ? problems.length + " problem(s)" : "ok"}`)
  for (let p of problems) console.log("  " + p)
}
console.log(`\n${total} blocks run, ${skipped} skipped (marked "test: no" in the original), ${failed} problem(s)`)
process.exit(failed ? 1 : 0)
