// Sandbox runtime for the LiaScript version of "Eloquent JavaScript".
//
// Ported from the sandbox of the book's own website
// (src/client/sandbox.mjs and ejs.mjs in github.com/marijnh/Eloquent-JavaScript,
// MIT licensed code by Marijn Haverbeke) and adapted to LiaScript:
// output goes to the console of the code block, frames live in the slide.
//
// Model, as on the original site:
// - Every chapter has sandboxes, each one an iframe. JavaScript blocks share
//   the sandbox "null" of their chapter (hidden frame); an HTML block gets a
//   visible frame of its own; blocks that name a sandbox share that frame.
// - Each sandbox first loads the chapter's files (the code the chapter
//   defines, plus helpers), so blocks can be run in any order.
// - Top-level let/const/class of a block become globals of the sandbox, so
//   later blocks see them.
;(function (global) {
  "use strict"

  const acorn = global.acorn
  const walk = acorn && acorn.walk
  const BUDGET = 400

  // ---------------------------------------------------------------- output

  function hop(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop)
  }

  function constructorName(obj) {
    if (!obj.constructor) return null
    let m = String(obj.constructor).match(/^(?:function|class)\s*([^\s({]+)/)
    if (m && m[1] != "Object") return m[1]
    return null
  }

  function represent(val, space) {
    if (space == null) space = BUDGET
    if (typeof val == "boolean" || typeof val == "number" || typeof val == "bigint") return String(val)
    if (typeof val == "string") return JSON.stringify(val)
    if (typeof val == "symbol") return String(val)
    if (val == null) return String(val)
    if (Array.isArray(val)) return representArray(val, space)
    return representObj(val, space)
  }

  function representArray(val, space) {
    space -= 2
    let out = "["
    for (let i = 0; i < val.length; ++i) {
      if (i) { out += ", "; space -= 2 }
      let next = space > 0 ? represent(val[i], space) : null
      let nextSize = next ? next.length : 0
      if (space - nextSize <= 0) { out += "…"; break }
      space -= nextSize
      out += next
    }
    return out + "]"
  }

  function representObj(val, space) {
    let string
    try { string = typeof val.toString == "function" && val.toString() } catch (_) { string = null }
    let m
    if (!string || /^\[object .*\]$/.test(string)) return representSimpleObj(val, space)
    if (val.call && (m = string.match(/^\s*(function[^(]*\([^)]*\))/))) return m[1] + "{…}"
    return string
  }

  function representSimpleObj(val, space) {
    space -= 2
    let out = "", name = constructorName(val)
    if (name) { space -= name.length; out += name }
    out += "{"
    try {
      let first = true
      for (let prop in val) if (hop(val, prop)) {
        if (first) first = false
        else { space -= 2; out += ", " }
        let next = space > 0 ? represent(val[prop], space) : null
        let nextSize = next ? prop.length + 2 + next.length : 0
        if (space - nextSize <= 0) { out += "…"; break }
        space -= nextSize
        out += prop + ": " + next
      }
    } catch (e) {
      out += "…"
    }
    return out + "}"
  }

  function formatArgs(args) {
    let text = ""
    for (let i = 0; i < args.length; i++) {
      if (i) text += " "
      text += typeof args[i] == "string" ? args[i] : represent(args[i])
    }
    return text
  }

  // Wraps the console of a LiaScript code block.
  function makeOutput(con) {
    return {
      empty: true,
      out(type, args) {
        this.empty = false
        let f = con[type] || con.log
        f.call(con, formatArgs(args))
      }
    }
  }

  // ------------------------------------------------------------ preprocess

  function randomID() {
    return Math.floor(Math.random() * 0xffffffff).toString(16)
  }

  function detectSourceType(code) {
    return /(^|\n)\s*(im|ex)port\b/.test(code) ? "module" : "script"
  }

  function importPatch(node) {
    let req = "require(" + node.source.raw + ")", text
    if (node.specifiers.length == 0) {
      text = req
    } else if (node.specifiers.length > 1 || node.specifiers[0].type == "ImportDefaultSpecifier") {
      let name = "m_" + node.source.value.replace(/\W+/g, "_") + "__"
      text = "var " + name + " = " + req
      node.specifiers.forEach(spec => {
        if (spec.type == "ImportDefaultSpecifier")
          text += ", " + spec.local.name + " = " + name + ".default || " + name
        else if (spec.type == "ImportNamespaceSpecifier")
          text += ", " + spec.local.name + " = " + name
        else
          text += ", " + spec.local.name + " = " + name + "." + spec.imported.name
      })
    } else {
      let spec = node.specifiers[0]
      text = "var " + spec.local.name + " = " + req +
        (spec.type == "ImportNamespaceSpecifier" ? "" : "." + spec.imported.name)
    }
    return {from: node.start, to: node.end, text: text + ";"}
  }

  function findAssignments(name, ast) {
    let found = false
    walk.ancestor(ast, {
      AssignmentExpression(node, ancestors) {
        if (node.left.type != "Identifier" || node.left.name != name) return
        for (let i = 2; i < ancestors.length; i++)
          if (/Statement|Declaration/.test(ancestors[i].type)) return
        found = true
      }
    })
    return found
  }

  function findAssignmentsTo(decls, ast) {
    let found = null
    for (let i = 0; i < decls.length; i++)
      walk.simple(decls[i].id, {
        VariablePattern(node) { if (findAssignments(node.name, ast)) found = node.name }
      }, null, null, "Pattern")
    return found
  }

  // Makes a block ready to run in a sandbox: loops get a guard against
  // endless running, imports become require calls, top-level declarations
  // become globals, and errors are reported to the output of the block.
  function preprocess(code) {
    if (!/\n$/.test(code)) code += "\n"
    let strict = /^(\s|\/\/.*)*["']use strict['"]/.test(code), ast
    try {
      ast = acorn.parse(code, {
        sourceType: detectSourceType(code), ecmaVersion: "latest",
        allowAwaitOutsideFunction: true
      })
    } catch (e) {
      return {code, dependencies: [], topAwait: false}
    }
    let patches = [], dependencies = [], topAwait = false
    let backJump = ";if (++__c % 1000 === 0) __sandbox.tick();"
    function loop(node) {
      if (node.body.type == "BlockStatement") {
        patches.push({from: node.body.end - 1, text: backJump})
      } else {
        patches.push({from: node.body.start, text: "{"},
                     {from: node.body.end, text: backJump + "}"})
      }
    }
    function addDep(name) { if (!dependencies.includes(name)) dependencies.push(name) }

    walk.ancestor(ast, {
      ForStatement: loop,
      ForInStatement: loop,
      ForOfStatement(node, ancestors) {
        loop(node)
        if (node.await && !ancestors.some(a => /Function/.test(a.type))) topAwait = true
      },
      WhileStatement: loop,
      DoWhileStatement: loop,
      AwaitExpression(node, ancestors) {
        if (!ancestors.some(a => /Function/.test(a.type))) topAwait = true
      },
      CallExpression(node) {
        if (node.callee.type == "Identifier" && node.callee.name == "require" &&
            node.arguments.length == 1 && node.arguments[0].type == "Literal" &&
            typeof node.arguments[0].value == "string")
          addDep(node.arguments[0].value)
      },
      ImportDeclaration(node) {
        addDep(node.source.value)
        patches.push(importPatch(node))
      },
      ExportNamedDeclaration(node) {
        if (node.source || !node.declaration)
          patches.push({from: node.start, to: node.end, text: ""})
        else
          patches.push({from: node.start, to: node.declaration.start, text: ""})
      },
      ExportDefaultDeclaration(node) {
        if (/Declaration/.test(node.declaration.type)) {
          patches.push({from: node.start, to: node.declaration.start, text: ""})
        } else {
          patches.push({from: node.start, to: node.declaration.start, text: ";("},
                       {from: node.declaration.end, text: ")"})
        }
      },
      ExportAllDeclaration(node) {
        patches.push({from: node.start, to: node.end, text: ""})
      }
    })

    let tryPos = 0, catchPos = ast.end, globals = []
    for (let i = strict ? 1 : 0; i < ast.body.length; i++) {
      let stat = ast.body[i]
      if (stat.type != "FunctionDeclaration") {
        if (tryPos == 0) tryPos = stat.start
        catchPos = stat.end
      }
      if (stat.type == "VariableDeclaration" && stat.kind != "var") {
        if (stat.kind == "const") {
          let found = findAssignmentsTo(stat.declarations, ast)
          if (found) patches.push({from: 0, text: `throw new TypeError("invalid assignment to const '${found}'");`})
        }
        patches.push({from: stat.start, to: stat.start + stat.kind.length, text: "var"})
      }
      if (stat.type == "ClassDeclaration")
        patches.push({from: stat.start, text: "var " + stat.id.name + " = "})
      // With a top-level await the block runs inside an async function;
      // remember what it declares so that it can still be made global.
      if (stat.type == "VariableDeclaration")
        for (let decl of stat.declarations)
          walk.simple(decl.id, {VariablePattern(node) { globals.push(node.name) }}, null, null, "Pattern")
      else if ((stat.type == "ClassDeclaration" || stat.type == "FunctionDeclaration") && stat.id)
        globals.push(stat.id.name)
    }

    if (topAwait) {
      // Everything, function declarations included, moves into the async function.
      patches.push({from: 0, text: "(async function(){try{", priority: 10})
      let publish = globals.map(n => `__sandbox.win[${JSON.stringify(n)}] = ${n};`).join("")
      patches.push({from: ast.end, text: `\n${publish}}catch(e){__sandbox.error(e);}})()`, priority: -10})
    } else {
      patches.push({from: tryPos, text: "try{", priority: 10})
      patches.push({from: catchPos, text: "}catch(e){__sandbox.error(e);}", priority: -10})
    }
    patches.sort((a, b) => a.from - b.from || (a.to || a.from) - (b.to || b.from) || (b.priority || 0) - (a.priority || 0))
    let out = "", pos = 0
    for (let i = 0; i < patches.length; ++i) {
      let patch = patches[i]
      out += code.slice(pos, patch.from) + patch.text
      pos = patch.to || patch.from
    }
    out += code.slice(pos, code.length)
    out += "\n//# sourceURL=code" + randomID()
    return {code: (strict ? '"use strict";' : "") + out, dependencies, topAwait}
  }

  function findDeps(code) {
    let deps = [], ast
    try { ast = acorn.parse(code, {ecmaVersion: "latest"}) }
    catch (e) { return deps }
    walk.simple(ast, {
      CallExpression(node) {
        if (node.callee.type == "Identifier" && node.callee.name == "require" &&
            node.arguments.length == 1 && node.arguments[0].type == "Literal" &&
            typeof node.arguments[0].value == "string" && !deps.includes(node.arguments[0].value))
          deps.push(node.arguments[0].value)
      }
    })
    return deps
  }

  function resolveRelative(base, path) {
    if (!/\.\.?\//.test(path)) return path
    base = base.replace(/[^\/]+$/, "")
    let m
    while (m = /^\.(\.)?\//.exec(path)) {
      if (m[1]) base = base.replace(/\/[^\/]+\/$/, "/")
      path = path.slice(m[0].length)
    }
    return base + path
  }

  class Cached {
    constructor(mapping) {
      this.mapping = mapping
      this.work = Object.create(null)
      this.done = Object.create(null)
    }
    compute(value) {
      return this.work[value] || (this.work[value] = this.mapping(value).then(result => this.done[value] = result))
    }
    store(value, result) {
      this.work[value] = Promise.resolve(result)
      return this.done[value] = result
    }
    get(value) { return this.done[value] }
  }

  // Cache for loaded module code; unknown packages are looked up on unpkg,
  // as the original site does.
  const resolved = new Cached(name => fetch("https://unpkg.com/" + name.replace(/\/$/, "")).then(resp => {
    if (resp.status >= 400) throw new Error(`Failed to resolve package '${name}'`)
    let found = resp.url.replace(/.*unpkg\.com\//, "")
    let known = resolved.get(found)
    return known || resp.text().then(code => resolved.store(found, {name: found, code}))
  }))

  function parseStack(stack) {
    let found = [], m
    let re = /([\w$]*)@(.*?):(\d+)|\bat (?:([^\s(]+) \()?(.*?):(\d+)/g
    while (m = re.exec(stack || "")) {
      let fn = m[1] || m[4] || null
      let file = m[2] || m[5] || null
      if (fn && /sandbox/i.test(fn)) break
      if (!file || !/code[0-9a-f]+$/.test(file)) continue
      found.push({fn, file, line: m[3] || m[6]})
    }
    return found
  }

  // ------------------------------------------------------------------- Box

  // One sandbox: a global object (the window of an iframe, or a vm context
  // in the tests) in which the blocks of a chapter run.
  class Box {
    constructor(win, frame) {
      this.win = win
      this.frame = frame || null
      this.startedAt = null
      this.extraSecs = 2
      this.output = null
      this.session = null
      this.timeouts = new Set()
      this.intervals = new Set()
      this.frames = []
      this.framePos = 0
      this.busy = 0
      this.loaded = new Cached(name => resolved.compute(name).then(({name, code}) => this.evalModule(name, code)))
      this.setupEnv()
    }

    // --- running

    begin(output, session) {
      this.output = output
      this.session = session || null
    }

    guard(f) {
      this.startedAt = Date.now()
      this.win.__c = 0
      try { return f() }
      catch (e) { this.error(e) }
    }

    async run(code) {
      this.startedAt = Date.now()
      this.extraSecs = 2
      this.win.__c = 0
      this.busy++
      try {
        let prepared = await this.prepare(code)
        let value = this.sandbox_run(prepared.code)
        if (prepared.topAwait) value = await value
        return value
      } catch (err) {
        this.error(err)
      } finally {
        this.busy--
      }
    }

    // Should be above all user-run code, so that the stack trace can be
    // cut off at this point.
    sandbox_run(code) {
      return this.win.eval(code)
    }

    async prepare(text) {
      let result = preprocess(text)
      await Promise.all(result.dependencies.map(dep => this.loaded.compute(dep)))
      return result
    }

    // Loads a plain script (a chapter file) into the global scope.
    load(code, name) {
      this.win.eval(code + "\n//# sourceURL=" + (name || "file" + randomID()))
    }

    evalModule(name, code) {
      if (/\.json$/.test(name))
        return this.loaded.store(name, {exports: JSON.parse(code)})
      let work = findDeps(code).map(dep => this.loaded.compute(resolveRelative(name, dep)))
      return Promise.all(work).then(() => {
        let f = new this.win.Function("require, exports, module, __dirname, __filename",
                                      code + "\n//# sourceURL=code" + randomID())
        let module = this.loaded.store(name, {exports: {}})
        f(dep => this.require(resolveRelative(name, dep)), module.exports, module, name, name)
        return module
      })
    }

    require(name) {
      let found = resolved.get(name)
      if (!found) throw new Error(`Could not load module '${name}'`)
      return this.loaded.get(found.name).exports
    }

    // --- environment

    setupEnv() {
      let win = this.win
      win.__sandbox = this
      win.__c = 0

      win.onerror = (e, _file, line) => {
        if (!this.output) return
        this.output.out("error", [e + (line != null ? " (line " + line + ")" : "")])
        return true
      }
      win.console = {
        log: (...args) => this.out("log", args),
        error: (...args) => this.out("error", args),
        warn: (...args) => this.out("warn", args),
        info: (...args) => this.out("log", args),
        debug: (...args) => this.out("log", args)
      }

      let setT = win.setTimeout, clearT = win.clearTimeout
      let setI = win.setInterval, clearI = win.clearInterval
      win.__setTimeout = setT
      let call = (code, args) => this.guard(() => typeof code == "string" ? win.eval(code) : code(...args))
      win.setTimeout = (code, time, ...args) => {
        let id = setT.call(win, () => {
          this.timeouts.delete(id)
          call(code, args)
          this.settle()
        }, time)
        this.timeouts.add(id)
        return id
      }
      win.clearTimeout = id => {
        this.timeouts.delete(id)
        clearT.call(win, id)
        this.settle()
      }
      win.setInterval = (code, time, ...args) => {
        let id = setI.call(win, () => call(code, args), time)
        this.intervals.add(id)
        return id
      }
      win.clearInterval = id => {
        this.intervals.delete(id)
        clearI.call(win, id)
        this.settle()
      }
      if (win.requestAnimationFrame) {
        let reqAnimFrame = win.requestAnimationFrame
        win.requestAnimationFrame = f => {
          let val = reqAnimFrame.call(win, time => this.guard(() => f(time)))
          if (this.frames.length > 50) this.frames[this.framePos++ % 50] = val
          else this.frames.push(val)
          return val
        }
      }
      if (win.fetch) {
        let nativeFetch = win.fetch
        win.fetch = (...args) => {
          this.busy++
          let done = () => { this.busy--; setT.call(win, () => this.settle(), 50) }
          let p = nativeFetch.apply(win, args)
          p.then(done, done)
          return p
        }
      }
      if (win.addEventListener)
        win.addEventListener("unhandledrejection", e => { this.error(e.reason); e.preventDefault() })

      win.require = name => this.require(name)
      win.require.preload = (name, code) => resolved.store(name, {name, code})
      win.module = {exports: {}}
      win.exports = win.module.exports
    }

    tick() {
      let now = Date.now()
      if (this.startedAt == null) this.startedAt = now
      if (now < this.startedAt + this.extraSecs * 1000) return
      let ask = this.win.__confirm || global.confirm
      let bail = ask ? ask("This code has been running for " + this.extraSecs + " seconds. Abort it?") : true
      this.startedAt += Date.now() - now
      this.extraSecs += Math.max(this.extraSecs, 8)
      if (bail) throw new Error("Aborted")
    }

    out(type, args) {
      if (this.output) this.output.out(type, args)
      else if (global.console) global.console[type].apply(global.console, args)
    }

    error(exception) {
      if (!this.output) throw exception
      let stack = parseStack(exception && exception.stack)
      let text = String(exception)
      if (/^\[object/.test(text) && exception && exception.message) text = exception.message
      this.output.out("error", [text + (stack.length ? " (line " + stack[0].line +
        (stack[0].fn ? " in function " + stack[0].fn : "") + ")" : "")])
    }

    clearEvents() {
      let win = this.win
      for (let id of this.timeouts) win.clearTimeout(id)
      for (let id of this.intervals) win.clearInterval(id)
      if (win.cancelAnimationFrame) for (let id of this.frames) win.cancelAnimationFrame(id)
      this.timeouts.clear(); this.intervals.clear()
      this.frames.length = this.framePos = 0
    }

    // --- end of a run

    // True while something the block started may still produce output.
    get pending() {
      // A visible frame keeps animating after its run has ended; running the
      // block again resets it.
      return this.busy > 0 || this.timeouts.size > 0 || (this.intervals.size > 0 && !this.visible)
    }

    settle() {
      let session = this.session
      if (!session || session.done || this.pending) return
      session.done = true
      if (session.onDone) session.onDone()
    }

    // Ends the run of the block once timers and requests are through.
    finishSoon(delay) {
      let session = this.session
      if (!session) return
      let check = () => { if (this.session == session) this.settle() }
      ;(this.win.__setTimeout || setTimeout).call(this.win, check, delay == null ? 60 : delay)
    }

    stop() {
      this.clearEvents()
      this.settle()
    }

    // --- HTML (browser only)

    async setHTML(code, root) {
      this.clearEvents()
      let doc = this.win.document, scriptTags = [], box = this
      this.frame.style.display = "block"
      let scriptRE = /<script\b[^>]*?(?:\bsrc\s*=\s*('[^']+'|"[^"]+"|[^\s>]+)[^>]*)?>([\s\S]*?)<\/script>/g
      let html = code.replace(scriptRE, function (_, src, content) {
        if (src && /["']/.test(src.charAt(0))) src = src.slice(1, src.length - 1)
        scriptTags.push(src ? {src} : {text: preprocess(content).code})
        return ""
      })
      doc.documentElement.innerHTML = baseTag(root) + html
      await inlineStyles(doc)

      this.frame.style.height = "80px"
      this.resizeFrame()

      for (let item of scriptTags) {
        this.startedAt = Date.now()
        this.extraSecs = 2
        this.win.__c = 0
        if (item.src) {
          try {
            let text = await fetchText(new URL(item.src, doc.baseURI).href)
            this.guard(() => this.load(text, item.src))
          } catch (e) {
            // Not readable as text (another origin): let the browser load it.
            let tag = doc.createElement("script")
            tag.src = item.src
            doc.body.appendChild(tag)
            await new Promise(ok => { tag.onload = tag.onerror = ok })
          }
        } else {
          await new Promise(ok => {
            let id = "cb" + randomID(), tag = doc.createElement("script")
            box.win[id] = () => { delete box.win[id]; ok() }
            tag.text = item.text + "\n;" + id + "();"
            doc.body.appendChild(tag)
            // A syntax error keeps the callback from running.
            box.win.__setTimeout.call(box.win, () => { if (box.win[id]) { delete box.win[id]; ok() } }, 500)
          })
        }
      }
      if (scriptTags.length || doc.querySelector("img")) setTimeout(() => this.resizeFrame(), 100)
      setTimeout(() => this.resizeFrame(), 600)
    }

    resizeFrame() {
      if (!this.frame || !this.win.document.documentElement) return
      this.frame.style.height =
        Math.max(80, Math.min(this.win.document.documentElement.offsetHeight + 2, 500)) + "px"
    }
  }

  // --------------------------------------------------------------- browser

  function baseTag(root) {
    return root ? '<base href="' + root.replace(/"/g, "&quot;") + '">' : ""
  }

  async function fetchText(url) {
    let resp = await fetch(url)
    if (!resp.ok) throw new Error("Could not load " + url + " (" + resp.status + ")")
    return resp.text()
  }

  // Style sheets served as plain text (raw file hosts) are refused by
  // browsers, so local ones are put into the page as <style>.
  async function inlineStyles(doc) {
    let links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))
    await Promise.all(links.map(async link => {
      try {
        let url = new URL(link.getAttribute("href"), doc.baseURI)
        let text = await fetchText(url.href)
        let style = doc.createElement("style")
        style.textContent = text.replace(/url\(\s*(['"]?)(?!data:|https?:|\/)([^'")]+)\1\s*\)/g,
          (_, q, path) => "url(" + JSON.stringify(new URL(path, url).href) + ")")
        link.replaceWith(style)
      } catch (_) { /* leave the link as it is */ }
    }))
  }

  function awaitEvent(target, event) {
    return new Promise(accept => {
      let done = () => { target.removeEventListener(event, done); accept() }
      target.addEventListener(event, done)
    })
  }

  // The folder of the course: relative paths of the book (img/, code/,
  // example/, css/) are resolved against it.
  function detectRoot() {
    if (global.EJS_ROOT) return global.EJS_ROOT
    let query = global.location ? decodeURIComponent(global.location.search.slice(1)) : ""
    if (/^https?:\/\//.test(query)) return new URL(".", query.split("#")[0]).href
    return new URL(".", global.document.baseURI).href
  }

  const state = {
    root: null,
    manifest: null,
    boxes: Object.create(null),
    queue: Promise.resolve()
  }

  function getRoot() {
    return state.root || (state.root = detectRoot())
  }

  function getManifest() {
    if (!state.manifest)
      state.manifest = fetchText(getRoot() + "code/chapters.json").then(JSON.parse).catch(e => {
        state.manifest = null
        throw e
      })
    return state.manifest
  }

  async function createBox(files, place) {
    let root = getRoot()
    let frame = document.createElement("iframe")
    frame.setAttribute("title", "Sandbox")
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8">' + baseTag(root) + "</head><body></body></html>"
    if (place) {
      frame.style.cssText = "display:block;width:100%;height:80px;border:1px solid #bbb;" +
        "border-radius:4px;background:white;box-sizing:border-box;margin:0.5rem 0"
      place.textContent = ""
      place.appendChild(frame)
    } else {
      frame.style.cssText = "position:absolute;width:0;height:0;border:none;visibility:hidden"
      frame.setAttribute("aria-hidden", "true")
      frame.tabIndex = -1
      document.body.appendChild(frame)
    }
    await awaitEvent(frame, "load")
    let box = new Box(frame.contentWindow, frame)
    box.root = root
    box.visible = !!place
    for (let file of files || []) {
      let text = await fetchText(new URL(file, root).href)
      box.guard(() => box.load(text, file))
    }
    if (place) {
      let resizeTimeout = null
      let scheduleResize = () => {
        clearTimeout(resizeTimeout)
        resizeTimeout = setTimeout(() => box.resizeFrame(), 200)
      }
      box.win.addEventListener("keydown", scheduleResize)
      box.win.addEventListener("mousedown", scheduleResize)
    }
    return box
  }

  // Finds or creates the sandbox for a block.
  async function getBox(opts) {
    let manifest = await getManifest()
    let chapter = manifest[opts.chapter] || {load: [], sandboxes: {}}
    let name = opts.sandbox && opts.sandbox != "null" ? opts.sandbox : null
    let place = opts.view || null

    // An HTML block without a name: a fresh frame of its own, every run.
    if (opts.html && !name) {
      let key = opts.chapter + "/html:" + opts.target
      dropBox(key)
      return state.boxes[key] = await createBox(chapter.load, place)
    }

    let key = opts.chapter + "/" + (name || "null")
    let box = state.boxes[key]
    if (box && box.frame.isConnected && !(opts.html && box.frame.parentNode != place)) return box
    dropBox(key)

    let html = name ? (chapter.sandboxes || {})[name] : null
    let visible = opts.html || html != null
    box = state.boxes[key] = await createBox(chapter.load, visible ? place : null)
    // A JavaScript block that runs in the frame of an HTML block: show the
    // page of that block first, without running its scripts.
    if (!opts.html && html != null) {
      box.win.document.documentElement.innerHTML = baseTag(box.root) + html
      await inlineStyles(box.win.document)
      box.resizeFrame()
    }
    return box
  }

  function slotPart(holder, name) {
    let part = holder.querySelector(":scope > ." + name)
    if (!part) {
      part = holder.appendChild(document.createElement("div"))
      part.className = name
    }
    return part
  }

  function dropBox(key) {
    let box = state.boxes[key]
    if (!box) return
    try { box.clearEvents() } catch (_) {}
    if (box.frame && box.frame.parentNode) box.frame.parentNode.removeChild(box.frame)
    delete state.boxes[key]
  }

  // The names a block defines at its top level (functions, classes,
  // bindings), for the note shown when a run prints nothing.
  function declaredNames(code) {
    let ast
    try {
      ast = acorn.parse(code, {
        sourceType: detectSourceType(code), ecmaVersion: "latest",
        allowAwaitOutsideFunction: true
      })
    } catch (_) { return [] }
    let names = []
    let add = name => { if (name && names.indexOf(name) < 0) names.push(name) }
    let pattern = node => {
      if (!node) return
      if (node.type == "Identifier") add(node.name)
      else if (node.type == "ObjectPattern") node.properties.forEach(p => pattern(p.value || p.argument))
      else if (node.type == "ArrayPattern") node.elements.forEach(pattern)
      else if (node.type == "AssignmentPattern") pattern(node.left)
      else if (node.type == "RestElement") pattern(node.argument)
    }
    for (let node of ast.body) {
      if (/^Export(Named|Default)Declaration$/.test(node.type) && node.declaration) node = node.declaration
      if (node.type == "FunctionDeclaration" || node.type == "ClassDeclaration") add(node.id && node.id.name)
      else if (node.type == "VariableDeclaration") node.declarations.forEach(d => pattern(d.id))
    }
    return names
  }

  // What the terminal says after a run without any output, so the reader
  // sees that the block was loaded. Null if nothing needs to be said.
  function silentNote(code, visible) {
    let names = declaredNames(code)
    if (names.length) {
      let shown = names.slice(0, 8).join(", ")
      return "Loaded: " + shown + (names.length > 8 ? " and " + (names.length - 8) + " more" : "")
    }
    // Without definitions a visible frame shows the effect itself.
    return visible ? null : "Done (no output)."
  }

  // Entry point of the macros: runs one code block.
  //   opts: {chapter, sandbox, html, expr, focus, target, code}
  //   con, send: console and send object of the LiaScript script
  function run(opts, con, send) {
    if (opts.flags) {
      opts.expr = /\bexpr\b/.test(opts.flags)
      opts.focus = /\bfocus\b/.test(opts.flags)
    }
    let output = makeOutput(con)
    // The slot below the block: the frame of the sandbox, if it is a
    // visible one, and a place where helper code of the book draws
    // (the robot animation, for example), as "output.div" on the website.
    let holder = opts.target ? document.getElementById(opts.target) : null
    if (holder) {
      opts.view = slotPart(holder, "ejs-view")
      output.div = slotPart(holder, "ejs-output")
      output.div.textContent = ""
    }
    let box
    let session = {done: false, onDone() {
      // A block that only defines something prints nothing: say that it ran.
      if (!opts.html && output.empty) {
        let drawn = !!(output.div && output.div.firstChild)
        let note = silentNote(opts.code, drawn || !!(box && box.visible))
        if (note) try { (con.debug || con.log).call(con, note) } catch (_) {}
      }
      try { send.lia("LIA: stop") } catch (_) {}
    }}
    // One block at a time, so a sandbox is never created twice.
    state.queue = state.queue.then(async () => {
      try {
        box = await getBox(opts)
      } catch (e) {
        output.empty = false
        con.error("Sandbox could not be started: " + (e && e.message || e))
        session.onDone()
        return
      }
      box.begin(output, session)
      if (send.handle) send.handle("stop", () => box.stop())
      if (opts.html) {
        await box.setHTML(opts.code, box.root)
        if (opts.focus) { box.win.focus(); if (box.win.document.body) box.win.document.body.focus() }
      } else {
        let value = await box.run(opts.code)
        if (value != null && opts.expr && output.empty) box.out("log", [value])
        if (box.visible) box.resizeFrame()
      }
      box.finishSoon()
    }).catch(e => {
      output.empty = false
      con.error(String(e))
      session.onDone()
    })
    return "LIA: wait"
  }

  function reset(chapter) {
    for (let key in state.boxes)
      if (!chapter || key.indexOf(chapter + "/") == 0) dropBox(key)
  }

  const EJS = {run, reset, Box, preprocess, represent, formatArgs, declaredNames, silentNote, state}
  if (typeof module == "object" && module.exports && !global.document) module.exports = EJS
  else global.EJS = EJS
})(typeof window != "undefined" ? window : globalThis)
