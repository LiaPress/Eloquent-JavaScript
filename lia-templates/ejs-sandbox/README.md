<!--
author:   LiaScript version of the sandbox of eloquentjavascript.net
version:  0.1.1
language: en
narrator: US English Female
comment:  Runs the code examples of the book "Eloquent JavaScript" the way its website does: one shared sandbox per chapter, visible frames for HTML examples.

script:   ./acorn.js
          ./acorn-walk.js
          ./sandbox.js

attribute: Sandbox logic ported from [Eloquent JavaScript](https://github.com/marijnh/Eloquent-JavaScript)
           by Marijn Haverbeke, code licensed under [MIT](https://eloquentjavascript.net/code/LICENSE).
           [Acorn](https://github.com/acornjs/acorn) is licensed under [MIT](https://github.com/acornjs/acorn/blob/master/acorn/LICENSE).

@EJS.js: @EJS.run_(@0,@1,@2,false,@uid)

@EJS.html: @EJS.run_(@0,@1,@2,true,@uid)

@EJS.run_
<script>
window.EJS.run({chapter: "@0", sandbox: "@1", flags: "@2", html: @3, target: "ejs-@4", code: `@'input`}, console, send)
</script>
<div id="ejs-@4" class="ejs-frame"></div>
@end
-->

# Eloquent JavaScript Sandbox

A template for the LiaScript version of the book
[Eloquent JavaScript](https://eloquentjavascript.net) by Marijn Haverbeke. It
runs the code examples as the website of the book does:

- All JavaScript blocks of a chapter share one sandbox (a hidden frame). What
  one block declares at the top level, later blocks can use.
- Before the first block runs, the sandbox loads the files of the chapter: the
  code the chapter itself defines, plus helper files. So blocks also work when
  they are run out of order.
- An HTML block is shown in a frame below the block. Blocks that name the same
  sandbox share one frame.
- Output of `console.log` appears below the block, written the way the book
  writes it after `// →`.
- A loop that runs for more than two seconds asks whether it should be aborted.

Import it in the header of the course:

`import: ./lia-templates/ejs-sandbox/README.md`

The course folder must contain `code/chapters.json`, which lists per chapter
the files to load and the pages of named sandboxes:

``` json
{
  "07_robot": {
    "load": ["code/chapter/07_robot.js", "code/animatevillage.js"],
    "sandboxes": {}
  }
}
```

Relative paths in the examples (`img/…`, `code/…`, `example/…`) are resolved
against the folder of the course.

## `@EJS.js`

Put `@EJS.js(chapter,sandbox,flags)` directly below a JavaScript block.

- `chapter`: key in `code/chapters.json`
- `sandbox`: `null` for the shared sandbox of the chapter, or a name
- `flags`: `-` for none; `expr` shows the value of the block if it prints nothing

``` javascript
let total = 0, count = 1;
while (count <= 10) {
  total += count;
  count += 1;
}
console.log(total);
// → 55
```
@EJS.js(demo,null,-)

The next block uses `total` from the block above:

``` javascript
console.log(total * 2, [1, 2, {a: "b"}]);
```
@EJS.js(demo,null,-)

## `@EJS.html`

Put `@EJS.html(chapter,sandbox,flags)` directly below an HTML block. The flag
`focus` moves the keyboard focus into the frame after the run.

``` html
<h1>Hello</h1>
<p>Click the button.</p>
<button>Count</button>
<script>
  let clicks = 0;
  document.querySelector("button").addEventListener("click", () => {
    clicks++;
    console.log("Clicked", clicks, "times");
  });
</script>
```
@EJS.html(demo,null,-)

## Implementation

The macros only hand the block to `EJS.run` in `sandbox.js`:

``` html
@EJS.js: @EJS.run_(@0,@1,@2,false,@uid)

@EJS.html: @EJS.run_(@0,@1,@2,true,@uid)

@EJS.run_
<script>
window.EJS.run({chapter: "@0", sandbox: "@1", flags: "@2", html: @3, target: "ejs-@4", code: `@'input`}, console, send)
</script>
<div id="ejs-@4" class="ejs-frame"></div>
@end
```
