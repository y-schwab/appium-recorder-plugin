# Appium Inspector code

These files are copied from the
[Appium Inspector](https://github.com/appium/appium-inspector) folder
`app/common/renderer` (Apache-2.0), keeping its folder structure, so that
the recorder can use its locator generation, page source parsing and
client-framework code generators on the server.

## Source

Copied from appium/appium-inspector `main` at `a63acd6e`, with these
changes:

- The syntax highlighting imports (`refractor/*`) and the `refractorLib`
  properties are removed from the code generators: the server does not
  highlight code.
- The code generators have three more actions (in `common.js`, with element
  id expressions in `java-common.js`, `python.js` and `js-wdio.js`):
  `comment`, `commentedOut` and `executeScriptWithElements`.
- Locator generation also uses the Windows UI Automation attributes
  `AutomationId`, `Name` and `ClassName` (`simple.js` and `xpath.js`).

## Updating

1. Copy the same files from a newer Appium Inspector version.
2. Remove the `refractor` imports and `refractorLib` properties again.
3. Reapply the changes above where the Inspector does not have them yet.
4. Run `npm test`.

Files here are not linted or formatted by this repository, so that they stay
easy to compare with the Inspector.
