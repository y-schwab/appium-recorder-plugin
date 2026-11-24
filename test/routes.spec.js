import {describe, expect, it} from 'vitest';

import {AppiumRecorderPlugin} from '../lib/index.js';
import {safeCaps, SessionRecording, store} from '../lib/recorder.js';
import {API_PATH, PAGE_PATH, rejectRequest} from '../lib/routes.js';

/** Collects the routes the plugin adds, so their handlers can be called directly. */
function fakeApp() {
  const routes = [];
  const add = (method) => (paths, handler) => {
    for (const p of [paths].flat()) {
      routes.push({method, path: p, handler});
    }
  };
  return {routes, get: add('GET'), post: add('POST'), delete: add('DELETE')};
}

function fakeReq({method = 'GET', ip = '127.0.0.1', headers = {}, params = {}, query = {}, path = '/'} = {}) {
  return {
    method,
    socket: {remoteAddress: ip},
    params,
    query,
    path,
    protocol: 'http',
    get: (name) => (name.toLowerCase() === 'host' ? '127.0.0.1:4723' : headers[name.toLowerCase()]),
  };
}

function fakeRes() {
  const res = {statusCode: 200, body: undefined, headersSent: false};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  res.type = () => res;
  res.send = res.json;
  return res;
}

async function call(app, method, path, req) {
  const route = app.routes.find((r) => r.method === method && r.path === path);
  const res = fakeRes();
  await route.handler(fakeReq({method, ...req}), res);
  return res;
}

describe('recorded capabilities', function () {
  it('keeps what the session ran against and drops everything else', function () {
    const caps = safeCaps({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:app': 'https://user:token@storage.example.com/app.apk?sig=secret',
      'appium:keychainPassword': 'hunter2',
      'cloud:options': {accessKey: 'secret'},
      accessKey: 'secret',
    });
    expect(caps).toEqual({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:app': 'https://storage.example.com/app.apk',
    });
    expect(safeCaps({'appium:app': 'C:\\apps\\Calc.exe'})).toEqual({'appium:app': 'C:\\apps\\Calc.exe'});
  });

  it('never stores secret capabilities in a recording', function () {
    const rec = new SessionRecording('caps-test', {platformName: 'iOS', 'appium:keychainPassword': 'hunter2'});
    expect(JSON.stringify(rec.toJSON())).not.toContain('hunter2');
  });
});

describe('recordings page access', function () {
  it('serves only this machine unless remote access is enabled', function () {
    const res = fakeRes();
    expect(rejectRequest(fakeReq({ip: '10.0.0.7'}), res)).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(rejectRequest(fakeReq({ip: '10.0.0.7'}), fakeRes(), {remoteUi: true})).toBe(false);
    expect(rejectRequest(fakeReq({ip: '::1'}), fakeRes())).toBe(false);
    expect(rejectRequest(fakeReq({ip: '::ffff:127.0.0.1'}), fakeRes())).toBe(false);
  });

  it('requires the page header for changes, so other sites cannot send them', function () {
    expect(rejectRequest(fakeReq({method: 'POST'}), fakeRes())).toBe(true);
    expect(rejectRequest(fakeReq({method: 'DELETE'}), fakeRes())).toBe(true);
    expect(rejectRequest(fakeReq({method: 'POST', headers: {'x-recorder-ui': '1'}}), fakeRes())).toBe(false);
  });

  it('adds the page and its API only with --plugin-recorder-ui', async function () {
    const without = fakeApp();
    await AppiumRecorderPlugin.updateServer(without, null, {plugin: {recorder: {}}});
    await AppiumRecorderPlugin.updateServer(without, null, {});
    expect(without.routes).toHaveLength(0);

    const off = fakeApp();
    await AppiumRecorderPlugin.updateServer(off, null, {plugin: {recorder: {ui: true, mode: 'off'}}});
    expect(off.routes).toHaveLength(0);

    const withUi = fakeApp();
    await AppiumRecorderPlugin.updateServer(withUi, null, {plugin: {recorder: {ui: true}}});
    const paths = withUi.routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`GET ${API_PATH}`);
    expect(paths).toContain(`POST ${API_PATH}/:sessionId/start`);
    expect(paths).toContain(`GET ${PAGE_PATH}`);
    // the page route matches every /recorder/* path, so it has to come last
    expect(paths.at(-1)).toBe(`GET ${PAGE_PATH}/*file`);
  });
});

describe('recordings API', function () {
  const settings = {plugin: {recorder: {ui: true, dir: `${process.env.TEMP ?? '/tmp'}/recorder-routes-test`}}};

  it('starts, reads and generates code for a live session', async function () {
    const app = fakeApp();
    await AppiumRecorderPlugin.updateServer(app, null, settings);
    store.noteSession('routes-live', {platformName: 'Windows'});

    const ui = {headers: {'x-recorder-ui': '1'}, params: {sessionId: 'routes-live'}};
    expect((await call(app, 'POST', `${API_PATH}/:sessionId/start`, ui)).body.state).toBe('recording');
    store.get('routes-live').recordCommand('findElement', ['accessibility id', 'OK'], {ELEMENT: 'e1'});
    store.get('routes-live').recordCommand('click', ['e1'], null);

    const code = await call(app, 'GET', `${API_PATH}/:sessionId/code`, {
      params: {sessionId: 'routes-live'},
      query: {format: 'python'},
    });
    expect(code.body.code).toContain('AppiumBy.ACCESSIBILITY_ID, value="OK"');

    const bad = await call(app, 'GET', `${API_PATH}/:sessionId/code`, {
      params: {sessionId: 'routes-live'},
      query: {format: 'cobol'},
    });
    expect(bad.statusCode).toBe(400);

    const remote = await call(app, 'GET', API_PATH, {ip: '192.168.1.20'});
    expect(remote.statusCode).toBe(403);
  });

  it('cannot start a recording without the page header', async function () {
    const app = fakeApp();
    await AppiumRecorderPlugin.updateServer(app, null, settings);
    store.noteSession('routes-csrf', {});
    const res = await call(app, 'POST', `${API_PATH}/:sessionId/start`, {params: {sessionId: 'routes-csrf'}});
    expect(res.statusCode).toBe(403);
    expect(store.get('routes-csrf')).toBeUndefined();
  });
});

describe('plugin session end', function () {
  it('forgets a session that ended without deleteSession (e.g. newCommandTimeout)', async function () {
    const plugin = new AppiumRecorderPlugin('recorder', {});
    const driver = {sessionId: 'timeout-test', caps: {}};
    await plugin.handle(async () => null, driver, 'getPageSource');
    expect(store.sessions.has('timeout-test')).toBe(true);
    await plugin.onUnexpectedShutdown(driver);
    expect(store.sessions.has('timeout-test')).toBe(false);
  });
});

describe('recordings page access from browsers', function () {
  it('refuses changes sent by a page on another site, even with the header', function () {
    const fromSite = fakeReq({method: 'POST', headers: {'x-recorder-ui': '1', origin: 'https://evil.example'}});
    const res = fakeRes();
    expect(rejectRequest(fromSite, res)).toBe(true);
    expect(res.body.error).toContain('https://evil.example');
    const fromPage = fakeReq({method: 'POST', headers: {'x-recorder-ui': '1', origin: 'http://127.0.0.1:4723'}});
    expect(rejectRequest(fromPage, fakeRes())).toBe(false);
  });
});
