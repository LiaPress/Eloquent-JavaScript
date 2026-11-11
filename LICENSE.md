# License

This repository contains a LiaScript version of the book
**Eloquent JavaScript, 4th edition**, by Marijn Haverbeke
(<https://eloquentjavascript.net>, sources:
<https://github.com/marijnh/Eloquent-JavaScript>).

## Text and images

Copyright © Marijn Haverbeke. Licensed under the
[Creative Commons Attribution-NonCommercial 3.0 Unported license](https://creativecommons.org/licenses/by-nc/3.0/)
(CC BY-NC 3.0; full text:
<https://creativecommons.org/licenses/by-nc/3.0/legalcode>).

You may copy, share and adapt the material for non-commercial purposes, as
long as you name the author, link the license and say what you changed.

Illustrations by various artists: cover by Péchane Sumi-e; chapter
illustrations by Madalina Tantareanu; pixel art in chapters 7 and 16 by
Antonio Perdomo Pastor; regular expression diagrams in chapter 9 generated
with regexper.com by Jeff Avallone; game concept for chapter 16 by Thomas
Palef.

## Code

All code of the book (the examples in `README.md` and the files in `code/`)
may also be considered licensed under the MIT license, see
[code/LICENSE](code/LICENSE).

The sandbox in `lia-templates/ejs-sandbox/` is ported from the sandbox of the
book's website (MIT, Marijn Haverbeke). It includes
[Acorn](https://github.com/acornjs/acorn) and acorn-walk (MIT).

## Changes in this version

`img/social-logo.jpg` is an AI-assisted landscape adaptation of `img/cover.jpg`
(cover artwork by Péchane Sumi-e), created for the course logo and GitHub social
preview. The layout and typography were recomposed; the publisher badge was
omitted. It retains the CC BY-NC 3.0 license linked above.

This is an adaptation made by Andre Dietrich in November 2026. It is not the
original and is not endorsed by the author. The text of the book is unchanged.

- All chapters are in one LiaScript document (`README.md`), generated from the
  original sources by `tools/convert.mjs`; links between chapters point into
  this document.
- Index marks and the passages written only for the printed book are left
  out; the passages written for the website are kept.
- The code examples run in a sandbox ported from the website of the book.
  Chapters 20 and 21 need Node.js and cannot be run in a browser.
- An example is run with the button below its block. Where the text says that
  examples run by clicking them, it describes the original website.
- Colors and layout follow the stylesheet of the book's website (`css/ejs.css`
  of the original, MIT). Its web fonts Cinzel and PT Mono are not used; the
  fonts of the reader's system take their place.
- `code/animatevillage.js`: an image path was changed, and two lines that only
  matter on the original website were removed.
- `code/chapter/*.js` and `code/chapters.json` are built from the code blocks
  of the chapters, as the build of the original website does.

The adaptation is published under the same licenses as the original.
