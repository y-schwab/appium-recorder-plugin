// Recordings page of the Appium Recorder plugin. Plain DOM, no build step.
// Everything recorded (app names, typed text, locators) is shown with textContent, never as HTML.

const API = './api/recordings';
const POLL_MS = 2000;
const FRAMEWORKS = [
  ['python', 'Python'],
  ['java', 'Java - JUnit4'],
  ['javaJUnit5', 'Java - JUnit5'],
  ['jsWdIo', 'JS/TS - WebdriverIO'],
  ['jsOxygen', 'JS - Oxygen HQ'],
  ['dotNetNUnit', '.NET - NUnit'],
  ['ruby', 'Ruby'],
  ['robot', 'Robot Framework'],
];

const $ = (sel) => document.querySelector(sel);
const state = {list: [], selectedId: null, selected: null, codeKey: null};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child instanceof Node ? child : String(child));
    }
  }
  return node;
}

async function request(url, {method = 'GET'} = {}) {
  // the header tells the server the change comes from this page (see lib/routes.js)
  const res = await fetch(url, {method, headers: method === 'GET' ? {} : {'X-Recorder-UI': '1'}});
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    // the plugin answers {error}, Appium itself a W3C error {value: {message}}
    const message = body?.error ?? body?.value?.message ?? `HTTP ${res.status}`;
    if (/browser-origin requests are not allowed/i.test(message)) {
      throw new Error(
        'Appium blocks changes sent from a browser unless CORS is allowed. To record, pause, stop or ' +
          'delete from this page, start Appium with --allow-insecure=*:cors (Appium 4) or --allow-cors (Appium 3).',
      );
    }
    throw new Error(message);
  }
  return body;
}

const recordingUrl = (id, suffix = '') => `${API}/${encodeURIComponent(id)}${suffix}`;

// loading errors come and go with each refresh; a failed action stays until it is dismissed
function showError(message) {
  const box = $('#error');
  box.hidden = !message;
  box.textContent = message ?? '';
}

function showActionError(message) {
  const box = $('#action-error');
  box.hidden = !message;
  $('#action-error-text').textContent = message ?? '';
}

function statusTag(rec) {
  if (rec.state === 'idle') {
    return el('span', {className: 'tag', textContent: 'not recorded'});
  }
  if (rec.active && rec.paused) {
    return el('span', {className: 'tag paused', textContent: 'paused'});
  }
  if (rec.active) {
    return el('span', {className: 'tag live', textContent: '● recording'});
  }
  return el('span', {className: 'tag', textContent: 'finished'});
}

const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

function controls(rec) {
  const box = el('span', {className: 'controls'});
  const button = (label, action, className = '') =>
    el('button', {
      type: 'button',
      className,
      textContent: label,
      onclick: (e) => {
        e.stopPropagation();
        void control(rec, action);
      },
    });
  if (rec.sessionLive && rec.state === 'idle') {
    box.append(button('● Record', 'start', 'danger'));
  }
  if (rec.active) {
    box.append(button(rec.paused ? 'Resume' : 'Pause', rec.paused ? 'resume' : 'pause'));
    box.append(button('Stop', 'stop'));
  }
  if (rec.state === 'finished') {
    box.append(button('Delete', 'delete', 'danger'));
  }
  return box;
}

async function control(rec, action) {
  if (action === 'delete') {
    const where = rec.savedTo ? `\n\nThis also deletes its files in ${rec.savedTo}.` : '';
    if (!confirm(`Delete the recording of session ${rec.sessionId}?${where}`)) {
      return;
    }
  }
  try {
    if (action === 'delete') {
      await request(recordingUrl(rec.sessionId), {method: 'DELETE'});
      if (state.selectedId === rec.sessionId) {
        select(null);
      }
    } else {
      await request(recordingUrl(rec.sessionId, `/${action}`), {method: 'POST'});
    }
    showActionError(null);
  } catch (err) {
    showActionError(`Could not ${action} the recording: ${err.message}`);
  }
  await refresh(true);
}

function renderList() {
  const body = $('#recordings tbody');
  body.replaceChildren(
    ...state.list.map((rec) => {
      const row = el(
        'tr',
        {className: rec.sessionId === state.selectedId ? 'selected' : '', onclick: () => select(rec.sessionId)},
        el('td', {}, statusTag(rec)),
        el('td', {textContent: formatTime(rec.startedAt)}),
        el('td', {className: 'ellipsis', textContent: rec.app || rec.platformName || '—', title: rec.app ?? ''}),
        el('td', {textContent: rec.state === 'idle' ? '—' : rec.steps}),
        el('td', {}, el('code', {textContent: rec.sessionId.slice(0, 8), title: rec.sessionId})),
        el('td', {}, controls(rec)),
      );
      return row;
    }),
  );
  $('#empty').hidden = state.list.length > 0;
}

function describeLocator(element) {
  if (!element) {
    return '';
  }
  if (element.suggested) {
    return `${element.suggested.strategy}: ${element.suggested.selector} ★`;
  }
  if (!element.strategy) {
    return `(no locator: ${element.elementId})`;
  }
  return `${element.strategy}: ${element.selector}${element.isArray ? ` (item ${element.index})` : ''}`;
}

const isScouting = (step) => step.action === 'read' && !!step.script && !step.element && !step.elements?.length;

function stepTarget(step) {
  if (step.element) {
    return describeLocator(step.element);
  }
  if (step.script) {
    const els = (step.elements ?? []).map(describeLocator).filter(Boolean);
    return els.length ? `${step.script} → ${els.join(', ')}` : step.script;
  }
  return '';
}

function stepValue(step) {
  if (isScouting(step)) {
    return '';
  }
  if (step.action === 'read') {
    return `${step.what} = ${JSON.stringify(step.result ?? null)}`;
  }
  if (step.value !== undefined) {
    return typeof step.value === 'string' ? step.value : JSON.stringify(step.value);
  }
  return '';
}

function renderSteps(rec) {
  $('#steps tbody').replaceChildren(
    ...(rec.steps ?? []).map((step) => {
      const label = isScouting(step) ? 'scouting' : step.action === 'read' ? 'verify' : step.action;
      const tag = el('span', {
        className: `tag ${label === 'verify' ? 'verify' : ''}`,
        textContent: `${label}${step.secret ? ' 🔒' : ''}`,
      });
      return el(
        'tr',
        {},
        el('td', {textContent: step.n}),
        el('td', {}, tag),
        el('td', {className: 'ellipsis', textContent: stepTarget(step), title: stepTarget(step)}),
        el('td', {className: 'ellipsis', textContent: stepValue(step), title: stepValue(step)}),
      );
    }),
  );
}

async function renderCode(rec, force = false) {
  const format = $('#framework').value;
  const boilerplate = $('#boilerplate').checked;
  const key = `${rec.sessionId}|${rec.steps?.length}|${rec.state}|${format}|${boilerplate}`;
  if (!force && key === state.codeKey) {
    return;
  }
  state.codeKey = key;
  if (!rec.steps?.length) {
    $('#code').textContent = 'Nothing recorded yet.';
    return;
  }
  try {
    const query = `?format=${encodeURIComponent(format)}${boilerplate ? '&boilerplate=1' : ''}`;
    const {code} = await request(recordingUrl(rec.sessionId, `/code${query}`));
    $('#code').textContent = code;
  } catch (err) {
    $('#code').textContent = `Could not generate code: ${err.message}`;
  }
}

function renderDetails() {
  const rec = state.selected;
  $('#details').hidden = !rec;
  if (!rec) {
    return;
  }
  $('#d-status').replaceChildren(statusTag(rec));
  $('#d-session').textContent = rec.sessionId;
  $('#d-meta').textContent = [rec.app, rec.platformName, formatTime(rec.startedAt), rec.savedTo]
    .filter(Boolean)
    .join(' · ');
  $('#d-controls').replaceChildren(controls(rec));
  const idle = rec.state === 'idle';
  $('#d-idle').hidden = !idle;
  $('#d-tabs').hidden = idle;
  if (!idle) {
    renderSteps(rec);
    $('#locators').textContent = rec.locatorsMd ?? '';
    void renderCode(rec);
  }
}

function select(sessionId) {
  state.selectedId = sessionId;
  state.selected = null;
  state.codeKey = null;
  renderList();
  renderDetails();
  void refresh(true);
}

async function refresh(force = false) {
  try {
    state.list = await request(API);
    showError(null);
  } catch (err) {
    showError(`Could not load the recordings: ${err.message}`);
    return;
  }
  renderList();
  const current = state.list.find((r) => r.sessionId === state.selectedId);
  const shown = state.selected;
  if (!current) {
    state.selected = null;
  } else if (current.state === 'idle') {
    state.selected = current; // nothing recorded yet: the list entry is all there is
  } else if (force || !shown || shown.state !== current.state || current.active) {
    // reload the details while the recording can still change
    state.selected = await request(recordingUrl(state.selectedId));
  }
  renderDetails();
}

function setupTabs() {
  for (const button of document.querySelectorAll('.tabs button')) {
    button.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.tabs button')) {
        b.classList.toggle('active', b === button);
      }
      for (const panel of document.querySelectorAll('[data-panel]')) {
        panel.hidden = panel.dataset.panel !== button.dataset.tab;
      }
    });
  }
}

function setup() {
  $('#server').textContent = location.host;
  const saved = localStorage.getItem('recorder.framework');
  $('#framework').replaceChildren(
    ...FRAMEWORKS.map(([value, label]) => el('option', {value, textContent: label, selected: value === saved})),
  );
  const rerender = () => {
    localStorage.setItem('recorder.framework', $('#framework').value);
    if (state.selected) {
      void renderCode(state.selected, true);
    }
  };
  $('#framework').addEventListener('change', rerender);
  $('#boilerplate').addEventListener('change', rerender);
  $('#copy-code').addEventListener('click', () => void navigator.clipboard.writeText($('#code').textContent));
  $('#download-locators').addEventListener('click', () => {
    if (state.selected) {
      const link = el('a', {
        href: recordingUrl(state.selected.sessionId, '/locators.md'),
        download: `locators_${state.selected.sessionId.slice(0, 8)}.md`,
      });
      link.click();
    }
  });
  $('#dismiss-error').addEventListener('click', () => showActionError(null));
  setupTabs();
  void refresh();
  // poll only while the page is visible
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      void refresh();
    }
  }, POLL_MS);
}

setup();
