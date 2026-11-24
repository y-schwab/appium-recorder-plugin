import {BasePlugin} from '@appium/base-plugin';

import {generateCode, SUPPORTED_FORMATS} from './codegen.js';
import {needsUpgrade, upgradeLocator} from './locator-upgrade.js';
import {isReadOnlyCommand, recorderSettings, store} from './recorder.js';
import {addRoutes} from './routes.js';

// element attributes that tell whether a field hides its text, with the value that means it does:
// IsPassword (UIA / wincore), password (UiAutomator2, Espresso), type (XCUITest secure text fields)
const PASSWORD_ATTRIBUTES = [
  ['IsPassword', 'true'],
  ['password', 'true'],
  ['type', 'xcuielementtypesecuretextfield'],
];
// capability that starts recording with the session: appium:recorderAutoStart = true
const AUTO_START_CAPABILITY = 'recorderAutoStart';

/**
 * Appium Recorder plugin: records what any client does in an Appium session (test code, an AI agent
 * working through an MCP server, the Appium Inspector...) and turns it into locators and test code.
 * @extends {BasePlugin}
 */
export class AppiumRecorderPlugin extends BasePlugin {
  /**
   * Recorder control for any WebDriver client, e.g. driver.executeScript('recorder: start').
   * These calls are never recorded themselves.
   */
  static executeMethodMap = {
    'recorder: start': {command: 'startRecording'},
    'recorder: stop': {command: 'stopRecording'},
    'recorder: pause': {command: 'pauseRecording'},
    'recorder: resume': {command: 'resumeRecording'},
    'recorder: clear': {command: 'clearRecording'},
    'recorder: get': {
      command: 'getRecording',
      params: {optional: ['format', 'boilerplate', 'includeSteps']},
    },
  };

  /**
   * @param {string} name - The name of the plugin
   * @param {Record<string, unknown>} cliArgs - This plugin's command line arguments
   * @param {string|null} [driverId]
   */
  constructor(name, cliArgs, driverId) {
    super(name, cliArgs, driverId);
    this.recorder = recorderSettings(cliArgs);
    // page source of the current app state, reused until a command may have changed it
    this.sourceCache = null;
  }

  /**
   * Records the successful commands of sessions whose recording was started, whichever client sent
   * them. Sessions that are not recorded only pass through, with a map lookup as their whole overhead.
   * Recording never changes the command's result or error.
   * @param {Function} next - Runs the command in the next plugin or the driver
   * @param {any} driver - The session's driver
   * @param {string} cmdName - Appium command name
   * @param {...any} args - Command arguments (payload params, then url params)
   * @returns {Promise<any>}
   */
  async handle(next, driver, cmdName, ...args) {
    if (cmdName === 'createSession') {
      const result = await next();
      if (this.recorder.enabled) {
        this.sessionCreated(result);
      }
      return result;
    }
    // deleteSession runs on Appium's umbrella driver, which gets the session id as its argument
    const sessionId = cmdName === 'deleteSession' ? (args[0] ?? driver?.sessionId) : driver?.sessionId;
    if (!this.recorder.enabled || !sessionId) {
      return await next();
    }
    if (cmdName === 'deleteSession') {
      const result = await next();
      store.sessionEnded(sessionId);
      if (store.get(sessionId)?.active) {
        await this.finishRecording(sessionId);
      }
      return result;
    }
    let rec = store.get(sessionId);
    if (!rec?.active) {
      if (rec || !(this.recorder.recordAll || this.wantsRecording(driver))) {
        store.noteSession(sessionId, driver.caps);
        return await next();
      }
      rec = store.start(sessionId, driver.caps);
    }
    // A paused recording still goes through here: it adds no steps (and suggests no locators), but
    // keeps tracking finds, so later steps keep their locators, and keeps the page source cache valid.
    const extra = cmdName === 'setValue' && !rec.paused ? {secret: await this.isPasswordField(driver, args[1])} : {};
    if (this.recorder.suggestLocators) {
      await this.suggestLocators(driver, cmdName, args);
    }
    const result = await next();
    if (cmdName === 'getPageSource' && typeof result === 'string') {
      this.sourceCache = result; // the client read it anyway: reuse it for suggestions
    } else if (!isReadOnlyCommand(cmdName, args)) {
      this.sourceCache = null;
    }
    try {
      // the recording may have been stopped while the command ran
      if (rec.active) {
        rec.recordCommand(cmdName, args, result, extra);
      }
    } catch (err) {
      this.log.warn(`Recorder could not record '${cmdName}': ${err.message}`);
    }
    return result;
  }

  /**
   * Execute scripts: 'recorder: ...' commands are handled here, all others are recorded like any
   * other command.
   * @param {Function} next
   * @param {any} driver
   * @param {string} script
   * @param {any[]} protoArgs
   * @returns {Promise<any>}
   */
  async execute(next, driver, script, protoArgs) {
    if (script in AppiumRecorderPlugin.executeMethodMap) {
      if (!this.recorder.enabled) {
        throw new Error('The recorder is disabled on this server (--plugin-recorder-mode=off)');
      }
      return await this.executeMethod(next, driver, script, protoArgs);
    }
    return await this.handle(next, driver, 'execute', script, protoArgs);
  }

  /**
   * A new session: start recording it right away when asked to, otherwise list it as a live
   * session that can be recorded. Appium's createSession returns {value: [sessionId, caps, protocol]}.
   * Never throws: an unexpected result only means the session shows up with its first command.
   * @param {any} result
   */
  sessionCreated(result) {
    const [sessionId, caps] = Array.isArray(result?.value) ? result.value : [];
    if (typeof sessionId !== 'string') {
      return;
    }
    if (this.recorder.recordAll || this.wantsRecording({caps})) {
      store.start(sessionId, caps);
      this.log.info(`Recording session ${sessionId}`);
    } else {
      store.noteSession(sessionId, caps);
    }
  }

  /**
   * @param {any} driver
   * @returns {boolean} whether the session asked to be recorded from its start
   */
  wantsRecording(driver) {
    const value =
      driver?.caps?.[AUTO_START_CAPABILITY] ??
      driver?.caps?.[`appium:${AUTO_START_CAPABILITY}`] ??
      driver?.opts?.[AUTO_START_CAPABILITY];
    return value === true || value === 'true';
  }

  recordingOf(driver) {
    const rec = store.get(driver?.sessionId);
    if (!rec) {
      throw new Error('This session is not being recorded. Call "recorder: start" first.');
    }
    return rec;
  }

  /** 'recorder: start': start recording this session (once: a stopped recording is final). */
  async startRecording(next, driver) {
    const rec = store.start(driver.sessionId, driver.caps);
    store.forgetSession(driver.sessionId);
    this.log.info(`Recording session ${driver.sessionId}`);
    return rec.summary();
  }

  /** 'recorder: stop': finish the recording and save it (steps.json, actions.json, locators.md). */
  async stopRecording(next, driver) {
    const rec = this.recordingOf(driver);
    await this.finishRecording(driver.sessionId);
    store.noteSession(driver.sessionId, driver.caps);
    return rec.summary();
  }

  /** 'recorder: pause' */
  async pauseRecording(next, driver) {
    const rec = this.recordingOf(driver);
    rec.paused = true;
    return rec.summary();
  }

  /** 'recorder: resume' */
  async resumeRecording(next, driver) {
    const rec = this.recordingOf(driver);
    rec.paused = false;
    return rec.summary();
  }

  /** 'recorder: clear': drop the steps recorded so far, keep recording. */
  async clearRecording(next, driver) {
    const rec = this.recordingOf(driver);
    rec.clear();
    return rec.summary();
  }

  /**
   * 'recorder: get': summary and locators.md, plus test code when `format` is given
   * (python, java, junit5, wdio, csharp, ruby, robot, oxygen) and the raw steps with includeSteps.
   */
  async getRecording(next, driver, format, boilerplate, includeSteps) {
    const rec = this.recordingOf(driver);
    const out = {...rec.summary(), locatorsMd: rec.toLocatorsMarkdown(), formats: SUPPORTED_FORMATS};
    if (format) {
      Object.assign(out, generateCode(rec, format, {boilerplate}));
    }
    if (includeSteps) {
      out.stepList = rec.steps;
    }
    return out;
  }

  /**
   * Before the first action on an element found with a weak locator (or none), find a unique
   * locator for it in the page source with the Appium Inspector's locator generation. Never throws
   * and never changes the command itself: only the recording uses the suggestion.
   * @param {any} driver
   * @param {string} cmdName
   * @param {any[]} args
   * @returns {Promise<void>}
   */
  async suggestLocators(driver, cmdName, args) {
    const rec = store.getOrCreate(driver.sessionId, driver.caps);
    const ids = rec.elementsToUpgrade(cmdName, args, needsUpgrade);
    if (!ids.length || typeof driver.getPageSource !== 'function') {
      return;
    }
    const automationName = driver.caps?.automationName;
    const getSource = async () => (this.sourceCache ??= await driver.getPageSource());
    for (const id of ids) {
      const started = Date.now();
      try {
        const suggested = await upgradeLocator(driver, id, automationName, getSource);
        rec.setSuggestedLocator(id, suggested);
        if (suggested) {
          this.log.debug(
            `Recorder suggests ${suggested.strategy} '${suggested.selector}' (${Date.now() - started} ms)`,
          );
        }
      } catch (err) {
        rec.setSuggestedLocator(id, null);
        this.log.warn(`Recorder could not suggest a locator: ${err.message}`);
      }
    }
  }

  /**
   * Saves the recording when the session ends without deleteSession (e.g. newCommandTimeout or a
   * driver crash).
   * @param {any} driver - The session's driver
   * @returns {Promise<void>}
   */
  async onUnexpectedShutdown(driver) {
    if (this.recorder.enabled && driver?.sessionId) {
      store.sessionEnded(driver.sessionId);
      await this.finishRecording(driver.sessionId);
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async finishRecording(sessionId) {
    const rec = store.finish(sessionId);
    if (!rec?.steps.length) {
      return;
    }
    try {
      const dir = await rec.save(this.recorder.outputDir);
      this.log.info(`Recorded ${rec.steps.length} steps of session ${sessionId} to ${dir}`);
    } catch (err) {
      this.log.warn(`Recorder could not save session ${sessionId}: ${err.message}`);
    }
  }

  /**
   * Whether typed text should be masked. Never throws: unknown means not a password field.
   * @param {any} driver
   * @param {string} elementId
   * @returns {Promise<boolean>}
   */
  async isPasswordField(driver, elementId) {
    if (!elementId || typeof driver?.getAttribute !== 'function') {
      return false;
    }
    for (const [name, secretValue] of PASSWORD_ATTRIBUTES) {
      try {
        if (String(await driver.getAttribute(name, elementId)).toLowerCase() === secretValue) {
          return true;
        }
      } catch {
        // attribute not supported by this driver
      }
    }
    return false;
  }

  /**
   * Adds the recordings page and its API, only when the server was started with
   * --plugin-recorder-ui.
   * @param {import('express').Application} expressApp
   * @param {unknown} httpServer
   * @param {Record<string, any>} [cliArgs] - All server arguments
   * @returns {Promise<void>}
   */
  static async updateServer(expressApp, httpServer, cliArgs) {
    const settings = recorderSettings(cliArgs?.plugin?.recorder);
    if (settings.enabled && settings.ui) {
      addRoutes(expressApp, settings);
    }
  }
}

export default AppiumRecorderPlugin;
