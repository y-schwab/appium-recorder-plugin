# appium-recorder-plugin

An [Appium](https://appium.io) plugin that records what any client does in a
session (test code, an AI agent working through an MCP server, the Appium
Inspector) and turns it into locators and test code.

The recorder runs inside the Appium server, so it sees every command of the
sessions it records, whichever client sends them. It reuses the locator
generation and code generators of the
[Appium Inspector](https://github.com/appium/appium-inspector) (see
[NOTICE](NOTICE)).

## Installation

```bash
appium plugin install --source=npm appium-recorder-plugin
appium --use-plugins=recorder
```

From a local clone:

```bash
appium plugin install --source=local /path/to/appium-recorder-plugin
```

Appium 3 and 4 are supported.

## Starting a Recording

Sessions are not recorded by default: sessions that are not recorded pass
through the plugin unchanged. A recording starts in one of these ways:

- From any client, with the `recorder: start` extension command
- When the session is created, with the `appium:recorderAutoStart`
  capability set to `true`
- For every session on the server, with `--plugin-recorder-mode=all`
- From the [recordings page](#recordings-page), with the **Record** button

A recording can be paused and resumed to leave steps out. Stopping a
recording is final: it is saved, and the same session cannot be recorded
again. Ending the session also stops and saves its recording.

## Extension Commands

Any Appium client can run these with its `executeScript` method. They are
never recorded themselves.

| Command | Description |
| --- | --- |
| `recorder: start` | Start recording the session |
| `recorder: pause` | Stop adding steps until resumed |
| `recorder: resume` | Continue adding steps |
| `recorder: clear` | Drop the steps recorded so far |
| `recorder: stop` | Finish the recording and save it |
| `recorder: get` | Get the recording, optionally as test code |

`recorder: get` returns the recording status and its `locators.md` summary.
Its optional parameters are:

- `format`: also return test code, in `python`, `java` (JUnit 4), `junit5`,
  `wdio`, `oxygen`, `ruby`, `csharp` or `robot`
- `boilerplate`: include the session setup code (`true` or `false`)
- `includeSteps`: also return the raw recorded steps (`true` or `false`)

For example, in Python:

```python
driver.execute_script('recorder: start')
# ... perform the scenario ...
recording = driver.execute_script('recorder: get', {'format': 'python'})
print(recording['code'])
driver.execute_script('recorder: stop')
```

AI agents can control the recorder through any MCP server that can run
driver extension commands, and get the generated test code directly from
`recorder: get`.

## What Is Recorded

Only commands that succeed are recorded, and only those that act on the
application or read from it:

- Element actions: click, clear and typing (`setValue`)
- Element reads, such as `getText` or `getAttribute`, which become
  verification comments in the generated code
- `executeScript` calls, including element references in their arguments
- Navigation commands and W3C actions (kept in `steps.json`, not yet turned
  into code)

Element finds are not recorded as steps: each action is linked to the
locator that found its element. Finds whose element is never used, page
source and screenshot requests, and other exploration are left out. Script
calls that only read and involve no element (for example
`windows: getWindows`) are kept with their result, but are commented out in
the generated code.

### Locator Suggestions

Before the first action on an element that was found with a locator other
than `accessibility id` (or with no locator), the recorder reads the page
source, finds the element in it, and uses the best unique locator suggested
by the Appium Inspector's locator generation in the generated code. The
original locator is kept as a comment. Each element is checked once, and the
page source is reused until a command may have changed the application.

This adds a few driver calls before the first action on such an element.
Turn it off with `--plugin-recorder-suggest=false`.

### Password Fields

Text typed with `setValue` into a field that the driver reports as a password
field is replaced with `{{PASSWORD}}`: the `IsPassword` attribute (Windows),
the `password` attribute (Android) or an `XCUIElementTypeSecureTextField`
(iOS).

Text typed in other ways is recorded as it is: the `keys` command, W3C key
actions, and scripts such as `mobile: type`. Do not record sessions that
type secrets that way.

### Capabilities

A recording keeps only the capabilities that describe what the session ran
against (`platformName`, `automationName`, `platformVersion`, `deviceName`,
`app`, `appTopLevelWindow`, `bundleId`, `appPackage`, `appActivity` and
`browserName`). Everything else, such as cloud access keys, is dropped, and
credentials and query strings are removed from `app` URLs.

## Saved Recordings

A stopped recording is saved into its own folder inside the recordings
folder (by default `appium-recordings` in the user's home directory):

- `steps.json`: the recorded steps and session details
- `actions.json`: the steps as Appium Inspector Recorder actions
- `locators.md`: one line per step with its locator

## Recordings Page

Started with `--plugin-recorder-ui`, the server also serves a page at
`/recorder` (for example `http://127.0.0.1:4723/recorder/`) that lists the
live sessions and recordings, shows their generated code, steps and
`locators.md`, and can record, pause, resume, stop and delete them.

The page lists every recording on the server, so access to it is limited:

- It is only served to the machine Appium runs on, unless the server is
  started with `--plugin-recorder-remote-ui`. Anyone who can reach the
  server can then read, control and delete recordings.
- Changes need a header that only the page sends, and are refused from
  other sites, even when Appium allows CORS.

Appium 4 refuses every change sent from a browser unless CORS is allowed.
Without `--allow-insecure=*:cors`, the page shows the recordings but cannot
control them; use the extension commands instead.

```bash
appium --use-plugins=recorder --plugin-recorder-ui
```

## Configuration

| Argument | Default | Description |
| --- | --- | --- |
| `--plugin-recorder-mode` | `on` | `on`, `all` or `off` (see above) |
| `--plugin-recorder-dir` | `~/appium-recordings` | Recordings folder |
| `--plugin-recorder-suggest` | `true` | Suggest unique locators |
| `--plugin-recorder-ui` | `false` | Serve the recordings page |
| `--plugin-recorder-remote-ui` | `false` | Serve it to other hosts too |

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
```

`lib/vendor/inspector` holds the Appium Inspector code the recorder uses.
See [its README](lib/vendor/inspector/README.md) for how to update it.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
