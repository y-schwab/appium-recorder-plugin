/**
 * The recordings page (/recorder) and its API (/recorder/api/recordings), added to the Appium server
 * only when it runs with --plugin-recorder-ui.
 *
 * The page lists every recording on this server, so access is limited:
 *   - only requests from this machine are served, unless --plugin-recorder-remote-ui is set;
 *   - requests that change something need the X-Recorder-UI header, and when they come from a
 *     browser, an Origin that is this server: a page on another site cannot start or delete
 *     recordings for you, even when Appium allows CORS.
 *
 * Appium 4 itself rejects every browser request that changes something unless CORS is allowed
 * (--allow-insecure=*:cors), so without it the page can show recordings but not control them.
 */
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {generateCode, SUPPORTED_FORMATS} from './codegen.js';
import {RecordingActiveError, RecordingFinishedError, store} from './recorder.js';

export const PAGE_PATH = '/recorder';
export const API_PATH = `${PAGE_PATH}/api/recordings`;
export const UI_HEADER = 'x-recorder-ui';
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Whether a request came from this machine. */
export function isLocalRequest(req) {
  return LOOPBACK.has(req.socket?.remoteAddress ?? '');
}

/**
 * Rejects requests the page should not serve: from other hosts (unless allowed) and changes
 * without the page's header. Returns true when the request was rejected.
 */
export function rejectRequest(req, res, {remoteUi = false} = {}) {
  if (!remoteUi && !isLocalRequest(req)) {
    res.status(403).json({error: 'The recordings page is only available from this machine'});
    return true;
  }
  if (SAFE_METHODS.has(req.method)) {
    return false;
  }
  if (req.get?.(UI_HEADER) !== '1') {
    res.status(403).json({error: `Missing ${UI_HEADER} header`});
    return true;
  }
  const origin = req.get?.('origin');
  if (origin !== undefined && !isSameOrigin(origin, req.get?.('host'))) {
    res.status(403).json({error: `Requests from ${origin} cannot change recordings`});
    return true;
  }
  return false;
}

/** Whether a browser's Origin header names this server (as the client reached it). */
function isSameOrigin(origin, host) {
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * @param {import('express').Application} expressApp
 * @param {{outputDir: string, remoteUi?: boolean}} settings
 */
export function addRoutes(expressApp, settings) {
  const {outputDir} = settings;
  const guard = (handler) => async (req, res) => {
    if (rejectRequest(req, res, settings)) {
      return;
    }
    try {
      await handler(req, res);
    } catch (err) {
      res.status(500).json({error: err.message});
    }
  };
  const withRecording = (handler, {liveOnly = false} = {}) =>
    guard(async (req, res) => {
      const {sessionId} = req.params;
      const rec = liveOnly ? store.get(sessionId) : await store.find(sessionId, outputDir);
      if (!rec) {
        res.status(404).json({error: `No recording for session ${sessionId}`});
        return;
      }
      await handler(rec, req, res);
    });
  const setPaused = (paused) =>
    withRecording(
      (rec, req, res) => {
        rec.paused = paused;
        res.json(rec.summary());
      },
      {liveOnly: true},
    );

  expressApp.get(
    API_PATH,
    guard(async (req, res) => res.json(await store.listAll(outputDir))),
  );
  expressApp.get(
    `${API_PATH}/:sessionId`,
    withRecording((rec, req, res) => res.json(rec.toJSON())),
  );
  expressApp.get(
    `${API_PATH}/:sessionId/locators.md`,
    withRecording((rec, req, res) => res.type('text/markdown').send(rec.toLocatorsMarkdown())),
  );
  // generated test code: ?format=python|java|junit5|wdio|csharp|ruby|robot|oxygen&boilerplate=1
  expressApp.get(
    `${API_PATH}/:sessionId/code`,
    withRecording((rec, req, res) => {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      try {
        res.json(generateCode(rec, req.query.format, {serverUrl, boilerplate: req.query.boilerplate === '1'}));
      } catch (err) {
        res.status(400).json({error: err.message, formats: SUPPORTED_FORMATS});
      }
    }),
  );
  expressApp.post(
    `${API_PATH}/:sessionId/start`,
    guard(async (req, res) => {
      const {sessionId} = req.params;
      if (!store.sessions.has(sessionId) && !store.get(sessionId)?.active) {
        res.status(404).json({error: `Session ${sessionId} has ended or does not exist on this server`});
        return;
      }
      try {
        const rec = store.start(sessionId);
        store.forgetSession(sessionId);
        res.json(rec.summary());
      } catch (err) {
        if (!(err instanceof RecordingFinishedError)) {
          throw err;
        }
        res.status(409).json({error: err.message});
      }
    }),
  );
  expressApp.post(
    `${API_PATH}/:sessionId/stop`,
    withRecording(
      async (rec, req, res) => {
        if (rec.active) {
          store.finish(rec.sessionId);
          store.noteSession(rec.sessionId, rec.caps);
          if (rec.steps.length) {
            await rec.save(outputDir);
          }
        }
        res.json(rec.summary());
      },
      {liveOnly: true},
    ),
  );
  expressApp.post(`${API_PATH}/:sessionId/pause`, setPaused(true));
  expressApp.post(`${API_PATH}/:sessionId/resume`, setPaused(false));
  // delete a finished recording and its saved files (a running one must be stopped first)
  expressApp.delete(
    `${API_PATH}/:sessionId`,
    guard(async (req, res) => {
      try {
        const result = await store.delete(req.params.sessionId, outputDir);
        if (!result) {
          res.status(404).json({error: `No recording for session ${req.params.sessionId}`});
          return;
        }
        res.json(result);
      } catch (err) {
        if (!(err instanceof RecordingActiveError)) {
          throw err;
        }
        res.status(409).json({error: err.message});
      }
    }),
  );

  // the page itself (after the API routes: this one matches every /recorder/* path)
  expressApp.get(
    [PAGE_PATH, `${PAGE_PATH}/*file`],
    guard(async (req, res) => {
      if (req.path === PAGE_PATH) {
        res.redirect(`${PAGE_PATH}/`);
        return;
      }
      const file = path.resolve(UI_DIR, req.path.slice(PAGE_PATH.length + 1) || 'index.html');
      // only the page's own files
      if (!file.startsWith(`${UI_DIR}${path.sep}`) || !(await isFile(file))) {
        res.status(404).json({error: 'Not found'});
        return;
      }
      res.sendFile(file);
    }),
  );
}
