const element = id => document.getElementById(id);
const content = element('edition-content');
const navigation = element('edition-navigation');
const status = element('edition-status');
const sections = [
  ['TOP_STORIES', 'Top Stories'], ['US', 'U.S.'], ['WORLD', 'World'],
  ['POLITICS_GOVERNMENT', 'Politics & Government'], ['BUSINESS_MARKETS', 'Business & Markets'],
  ['TECHNOLOGY', 'Technology'], ['SCIENCE', 'Science'], ['HEALTH', 'Health'],
];
const statusLabels = {
  ASSEMBLING: 'Assembling', NEEDS_REVIEW: 'Needs review', READY_FOR_APPROVAL: 'Ready for approval review',
  REVISION_REQUESTED: 'Changes requested', ON_HOLD: 'On hold', REJECTED: 'Rejected', INVALIDATED: 'Invalidated',
};
const node = (tag, text = '', className = '') => {
  const item = document.createElement(tag);
  item.textContent = text;
  if (className) item.className = className;
  return item;
};
const record = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max && value.trim().length > 0;
const list = (value, max) => Array.isArray(value) && value.length <= max;
function safeURL(value) {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.test') && !url.username && !url.password
      && ![...url.searchParams.keys()].some(key => /^(api_?key|token|access_token|key|secret|password)$/i.test(key));
  } catch { return false; }
}
function validSource(source) {
  return record(source, ['publisher', 'url']) && text(source.publisher, 256) && safeURL(source.url);
}
function validPlacement(placement) {
  return record(placement, ['headline', 'summary', 'featured', 'sources', 'uncertainties', 'counterevidence'])
    && text(placement.headline, 512) && text(placement.summary)
    && typeof placement.featured === 'boolean' && list(placement.sources, 64) && placement.sources.length > 0 && placement.sources.every(validSource)
    && list(placement.uncertainties, 16) && placement.uncertainties.every(value => text(value, 2048))
    && record(placement.counterevidence, ['recorded', 'label', 'sources'])
    && typeof placement.counterevidence.recorded === 'boolean' && text(placement.counterevidence.label, 512)
    && list(placement.counterevidence.sources, 64) && placement.counterevidence.sources.every(validSource)
    && placement.counterevidence.sources.every(counter => placement.sources.some(source => source.publisher === counter.publisher && source.url === counter.url))
    && (placement.counterevidence.recorded ? placement.counterevidence.sources.length > 0 : placement.counterevidence.sources.length === 0);
}
function validDisplay(data) {
  if (!record(data, ['fictional', 'developmentOnly', 'publiclyPublished', 'date', 'timezone', 'revision', 'status', 'reviewLabel', 'validForMs', 'sections'])
    || data.fictional !== true || data.developmentOnly !== true || data.publiclyPublished !== false
    || !text(data.date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)
    || !Number.isFinite(Date.parse(data.date)) || new Date(data.date).toISOString().slice(0, 10) !== data.date
    || !text(data.timezone, 128) || !Number.isSafeInteger(data.revision) || data.revision < 1
    || !Object.hasOwn(statusLabels, data.status) || !text(data.reviewLabel, 1024)
    || !Number.isSafeInteger(data.validForMs) || data.validForMs < 0 || data.validForMs > 15000) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }); } catch { return false; }
  if (data.status === 'INVALIDATED') return Array.isArray(data.sections) && data.sections.length === 0;
  if (data.validForMs === 0 || !Array.isArray(data.sections) || data.sections.length !== sections.length) return false;
  let featured = 0; let placements = 0;
  return data.sections.every((section, index) => {
    if (!record(section, ['id', 'label', 'placements']) || section.id !== sections[index][0] || section.label !== sections[index][1]
      || !list(section.placements, 100) || !section.placements.every(validPlacement)) return false;
    placements += section.placements.length;
    for (const placement of section.placements) if (placement.featured && (++featured > 1 || section.id !== 'TOP_STORIES')) return false;
    return placements <= 100;
  });
}

let generation = 0;
let pending = null;
let expiryTimer = null;
let refreshTimer = null;
let contentDeadline = 0;
let activeSignature = null;
function stopExpiry() {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  expiryTimer = null; refreshTimer = null;
}
function cancelRequest() { generation++; pending?.abort(); pending = null; }
function clearDisplay(message, state) {
  stopExpiry();
  contentDeadline = 0; activeSignature = null;
  content.replaceChildren();
  content.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  navigation.replaceChildren(); navigation.hidden = true;
  element('edition-data-header').hidden = true;
  for (const id of ['edition-date', 'edition-timezone', 'edition-state', 'edition-revision', 'edition-review']) element(id).textContent = '';
  element('edition-date').removeAttribute('datetime');
  status.textContent = message; status.dataset.state = state;
  if (state !== 'ready') content.append(node('p', message, 'edition-message'));
}
function sourceList(sources) {
  const list = node('ul', '', 'source-list');
  for (const source of sources) {
    const item = node('li');
    const link = node('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const arrow = node('span', '→', 'external-mark'); arrow.setAttribute('aria-hidden', 'true');
    link.append(node('span', source.publisher), arrow);
    item.append(link, node('span', new URL(source.url).hostname, 'source-host')); list.append(item);
  }
  return list;
}
function card(placement) {
  const article = node('article', '', `edition-card${placement.featured ? ' featured' : ''}`);
  const narrative = node('div', '', 'card-narrative');
  const kicker = node('p', '', 'card-kicker');
  if (placement.featured) kicker.append(node('span', 'Featured story', 'featured-label'));
  kicker.append(node('span', 'Fictional development story'));
  narrative.append(kicker, node('h3', placement.headline, 'card-headline'), node('p', placement.summary, 'card-summary'));
  const context = node('div', '', 'card-context');
  context.append(node('h4', 'Sources', 'context-heading'), sourceList(placement.sources));
  const uncertainty = node('div', '', 'uncertainty-box');
  uncertainty.append(node('h4', 'What remains uncertain', 'context-heading'));
  if (placement.uncertainties.length) {
    const list = node('ul', '', 'uncertainty-list');
    for (const value of placement.uncertainties) list.append(node('li', value));
    uncertainty.append(list);
  } else uncertainty.append(node('p', 'No uncertainty is recorded in the selected evidence.', 'context-note'));
  const counterevidence = node('div', '', 'counterevidence');
  counterevidence.append(node('h4', 'Counterevidence', 'context-heading'), node('p', placement.counterevidence.label));
  if (placement.counterevidence.recorded) counterevidence.append(sourceList(placement.counterevidence.sources));
  context.append(uncertainty, counterevidence); article.append(narrative, context);
  return article;
}
function focusLocation() {
  const focused = document.activeElement;
  if (!focused || !content.contains(focused)) return null;
  const region = focused.closest('.edition-section');
  if (!region) return null;
  const source = focused.closest('.source-list a');
  return {
    headingId: region.querySelector('h2')?.id,
    sourceURL: source?.getAttribute('href'),
    headline: source?.closest('.edition-card')?.querySelector('h3')?.textContent,
  };
}
function restoreFocus(location) {
  if (!location) return;
  let target = location.headingId && document.getElementById(location.headingId);
  if (location.sourceURL && location.headline) {
    const region = target?.closest('.edition-section');
    const article = [...(region?.querySelectorAll('.edition-card') ?? [])].find(article => article.querySelector('h3')?.textContent === location.headline);
    target = [...(article?.querySelectorAll('.source-list a') ?? [])].find(link => link.getAttribute('href') === location.sourceURL) ?? target;
  }
  target?.focus({ preventScroll: true });
}
function render(data) {
  const focused = focusLocation();
  content.replaceChildren();
  element('edition-date').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${data.date}T12:00:00Z`));
  element('edition-date').dateTime = data.date;
  element('edition-timezone').textContent = `Edition timezone: ${data.timezone}`;
  element('edition-state').textContent = statusLabels[data.status];
  element('edition-revision').textContent = `Revision ${data.revision}`;
  element('edition-review').textContent = data.reviewLabel;
  element('edition-data-header').hidden = false;
  const links = navigation.firstElementChild ? null : node('ul');
  for (const section of data.sections) {
    if (links) {
      const link = node('a', section.label); link.href = `#edition-section-${section.id}`;
      const item = node('li'); item.append(link); links.append(item);
    }
    const region = node('section', '', 'edition-section'); region.id = `edition-section-${section.id}`;
    const heading = node('h2', section.label); heading.id = `edition-heading-${section.id}`; heading.tabIndex = -1;
    region.setAttribute('aria-labelledby', heading.id);
    const header = node('div', '', 'section-heading');
    header.append(heading, node('span', section.placements.length ? `${section.placements.length} ${section.placements.length === 1 ? 'story' : 'stories'}` : 'No stories placed', 'section-count'));
    region.append(header);
    if (section.placements.length) {
      const grid = node('div', '', 'section-grid');
      for (const placement of section.placements) grid.append(card(placement));
      region.append(grid);
    } else region.append(node('p', 'No stories have been placed in this section.', 'section-empty'));
    content.append(region);
  }
  if (links) navigation.append(links);
  navigation.hidden = false; content.setAttribute('aria-busy', 'false');
  status.textContent = 'Fictional edition loaded.'; status.dataset.state = 'ready';
  restoreFocus(focused);
}
async function displaySignature(data) {
  if (!globalThis.crypto?.subtle) return null;
  const { validForMs: _, ...display } = data;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(display)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function armExpiry(deadline) {
  stopExpiry(); contentDeadline = deadline;
  const remaining = deadline - performance.now();
  if (remaining <= 0) { clearDisplay('Edition preview expired. Refresh to check again.', 'expired'); return; }
  expiryTimer = setTimeout(() => clearDisplay('Edition preview expired. Refresh to check again.', 'expired'), remaining);
  // Renew ordinary previews before their deadline. Near a source-rights deadline,
  // short-lived displays expire rather than creating a rapid polling loop.
  if (remaining >= 5000) refreshTimer = setTimeout(refresh, remaining - Math.min(5000, remaining / 3));
}
async function refresh() {
  cancelRequest();
  if (document.hidden) { clearDisplay('Edition content cleared while this page is inactive.', 'inactive'); return; }
  if (contentDeadline > performance.now() && status.dataset.state === 'ready') {
    content.setAttribute('aria-busy', 'true'); status.textContent = 'Checking the fictional edition…';
  } else clearDisplay('Loading the fictional edition…', 'loading');
  const current = generation;
  const controller = new AbortController(); pending = controller;
  const dispatchedAt = performance.now();
  const requestTimer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/dev/edition/preview', { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw Error('Unavailable');
    const data = await response.json();
    if (current !== generation || document.hidden) return;
    if (controller.signal.aborted || (data !== null && !validDisplay(data))) throw Error('Unavailable');
    if (data === null) { clearDisplay('No eligible fictional edition is available.', 'empty'); return; }
    if (data.status === 'INVALIDATED') { clearDisplay('Edition unavailable. Its story or source eligibility changed.', 'invalidated'); return; }
    const deadline = dispatchedAt + data.validForMs;
    if (performance.now() >= deadline) { clearDisplay('Edition preview expired. Refresh to check again.', 'expired'); return; }
    const signature = await displaySignature(data);
    if (current !== generation || document.hidden) return;
    if (controller.signal.aborted) throw Error('Unavailable');
    if (performance.now() >= deadline) { clearDisplay('Edition preview expired. Refresh to check again.', 'expired'); return; }
    if (signature === null || signature !== activeSignature || contentDeadline <= performance.now()) render(data);
    else { content.setAttribute('aria-busy', 'false'); status.textContent = 'Fictional edition loaded.'; }
    activeSignature = signature;
    armExpiry(deadline);
  } catch {
    if (current === generation && !document.hidden) clearDisplay('Edition unavailable. Refresh to check again.', 'unavailable');
  } finally {
    clearTimeout(requestTimer);
    if (pending === controller) pending = null;
  }
}
function suspend() { cancelRequest(); clearDisplay('Edition content cleared while this page is inactive.', 'inactive'); }
element('edition-refresh').addEventListener('click', refresh);
navigation.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link || !navigation.contains(link)) return;
  const id = link.getAttribute('href')?.slice(1);
  const region = id && document.getElementById(id);
  const heading = region?.querySelector('h2');
  if (!heading) return;
  event.preventDefault(); heading.focus({ preventScroll: true }); region.scrollIntoView({ block: 'start' });
  history.replaceState(null, '', link.getAttribute('href'));
});
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else refresh(); });
window.addEventListener('pagehide', suspend);
window.addEventListener('pageshow', refresh);
if (document.readyState === 'complete') refresh();
