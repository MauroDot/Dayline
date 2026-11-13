const element = id => document.getElementById(id);
const content = element('queue-content');
const status = element('queue-status');
const view = element('queue-view');
const limit = element('queue-limit');
const next = element('queue-next');
const reasons = {
  RETENTION_REVIEW_REQUIRED: 'A retention review or hold blocks editorial use.', SOURCE_DELETED: 'The source was deleted; its metadata is withheld.',
  RETENTION_EXPIRED: 'The retention deadline passed; source metadata is withheld.', POLICY_EXPIRED: 'The captured rights policy expired.',
  POLICY_REVOKED: 'The captured rights grant was revoked.', POLICY_SUPERSEDED: 'The captured rights grant was superseded.',
  MISSING_RIGHTS: 'No managed rights snapshot establishes eligibility.', UNKNOWN_RIGHTS: 'The captured rights could not be established.',
  MALFORMED_RECORD: 'The repository record could not be safely interpreted.', SOURCE_REMOVED: 'The source is no longer available in the repository.',
  PROVENANCE_UNRESOLVED: 'Source provenance needs human review.', PROVENANCE_DISPUTED: 'Source provenance is disputed and needs human review.',
  ORIGIN_UNAVAILABLE: 'The verified syndication origin is unavailable or ineligible.',
};
const record = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const reference = value => typeof value === 'string' && /^candidate-[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const choices = (value, values) => typeof value === 'string' && values.includes(value);
function safeURL(value) {
  if (value === null) return true;
  if (!text(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.test') && !url.username && !url.password && !url.search && !url.hash && url.href === value; }
  catch { return false; }
}
function validEntry(row, hold) {
  const metadata = [row?.publisher,row?.canonicalUrl,row?.publishedAt,row?.retrievedAt];
  const withheld = metadata.every(value => value === null);
  return record(row, ['candidateRef','publisher','canonicalUrl','publishedAt','retrievedAt','provenance','provenanceStatus','rightsStatus','retentionStatus','quarantineStatus','relationship','sourceEligible','canAdvance','blockedReason'])
    && reference(row.candidateRef) && (row.publisher === null || text(row.publisher, 256)) && safeURL(row.canonicalUrl)
    && (row.publishedAt === null || date(row.publishedAt)) && (row.retrievedAt === null || date(row.retrievedAt))
    && choices(row.provenance, ['PRIMARY','ORIGINAL','SECONDARY','SYNDICATED','UNKNOWN','DISPUTED'])
    && choices(row.provenanceStatus, ['RESOLVED','UNRESOLVED','DISPUTED'])
    && choices(row.rightsStatus, ['ACTIVE','MISSING','EXPIRED','REVOKED','SUPERSEDED','UNKNOWN'])
    && choices(row.retentionStatus, ['RETAINED','EXPIRED','DELETED','REVIEW_REQUIRED'])
    && choices(row.quarantineStatus, ['QUARANTINED','NOT_QUARANTINED','WITHHELD'])
    && typeof row.sourceEligible === 'boolean' && row.canAdvance === false
    && (row.blockedReason === null || Object.hasOwn(reasons, row.blockedReason))
    && withheld === (row.quarantineStatus === 'WITHHELD')
    && (withheld || (metadata.every(value => value !== null) && row.rightsStatus === 'ACTIVE' && ['RETAINED','REVIEW_REQUIRED'].includes(row.retentionStatus)))
    && (!['MALFORMED_RECORD','MISSING_RIGHTS','SOURCE_REMOVED'].includes(row.blockedReason) || withheld)
    && (row.sourceEligible ? !withheld && row.quarantineStatus === 'NOT_QUARANTINED' && row.rightsStatus === 'ACTIVE' && row.retentionStatus === 'RETAINED' && row.provenanceStatus === 'RESOLVED' && !['UNKNOWN','DISPUTED'].includes(row.provenance) && row.blockedReason === null && !hold : row.blockedReason !== null)
    && (!['EXPIRED','DELETED'].includes(row.retentionStatus) || [row.publisher,row.canonicalUrl,row.publishedAt,row.retrievedAt].every(value => value === null))
    && (row.relationship === null || (!withheld && record(row.relationship, ['kind','originRef']) && row.relationship.kind === 'SYNDICATED' && reference(row.relationship.originRef) && row.relationship.originRef !== row.candidateRef && row.provenance === 'SYNDICATED'));
}
function validDisplay(data) {
  return record(data, ['fictional','developmentOnly','publiclyPublished','asOf','validForMs','entries','nextCursor','view','limit','retentionReviewRequired'])
    && data.fictional === true && data.developmentOnly === true && data.publiclyPublished === false
    && data.asOf === '2026-06-01T12:00:00.000Z' && date(data.asOf)
    && Number.isSafeInteger(data.validForMs) && data.validForMs > 0 && data.validForMs <= 15000
    && data.view === view.value && data.limit === Number(limit.value) && typeof data.retentionReviewRequired === 'boolean'
    && (data.nextCursor === null || (text(data.nextCursor, 1024) && /^[A-Za-z0-9_-]+$/.test(data.nextCursor)))
    && Array.isArray(data.entries) && data.entries.length <= data.limit && data.entries.every(row => validEntry(row, data.retentionReviewRequired))
    && new Set(data.entries.map(row => row.candidateRef)).size === data.entries.length;
}
const node = (tag, text = '', className = '') => { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; };
const label = value => value.toLowerCase().replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
const formattedDate = value => value ? new Intl.DateTimeFormat('en-GB', {dateStyle:'medium', timeStyle:'short', timeZone:'UTC'}).format(new Date(value)) + ' UTC' : 'Withheld / unavailable';
function candidate(row) {
  const article = node('article', '', 'candidate' + (row.sourceEligible ? ' eligible' : ''));
  article.dataset.candidateRef = row.candidateRef;
  const heading = node('h3', row.publisher ?? 'Source metadata withheld'); heading.tabIndex = -1;
  article.append(node('p', 'Fictional source candidate', 'eyebrow'), heading, node('p', row.candidateRef, 'candidate-ref'));
  const badges = node('ul', '', 'status-list');
  for (const [prefix, value, attention] of [['Origin',row.provenance,row.provenanceStatus !== 'RESOLVED'], ['Rights',row.rightsStatus,row.rightsStatus !== 'ACTIVE'], ['Retention',row.retentionStatus,row.retentionStatus !== 'RETAINED'], ['Quarantine',row.quarantineStatus,row.quarantineStatus !== 'NOT_QUARANTINED']]) badges.append(node('li', `${prefix}: ${label(value)}`, 'badge' + (attention ? ' attention' : '')));
  article.append(badges);
  const details = node('dl');
  const detail = (name, value) => { details.append(node('dt', name), value instanceof Node ? value : node('dd', value)); };
  const attribution = node('dd');
  if (row.canonicalUrl) { const link = node('a', new URL(row.canonicalUrl).hostname + ' ↗', 'source-link'); link.href = row.canonicalUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', `Fictional source attribution: ${row.publisher ?? 'source'}`); attribution.append(link); }
  else attribution.textContent = 'Withheld / unavailable';
  detail('Attribution', attribution); detail('Published', formattedDate(row.publishedAt)); detail('Discovered', formattedDate(row.retrievedAt)); detail('Provenance', label(row.provenanceStatus));
  detail('Relationship', row.relationship ? `Verified syndicated copy of ${row.relationship.originRef}. This is not independent reporting.` : 'No verified syndication relationship.');
  article.append(details);
  const restriction = node('p', '', 'blocked-reason');
  restriction.append(node('strong', row.sourceEligible ? 'Eligible managed metadata · Inspection only' : 'Cannot advance'));
  restriction.append(document.createTextNode(row.blockedReason ? reasons[row.blockedReason] : 'Metadata is eligible at the historical fixture time. Human editorial approval remains required.'));
  article.append(restriction);
  return article;
}
let generation = 0, pending = null, expiryTimer = null, currentCursor = null, nextCursor = null, pageNumber = 1;
function clear(message, state) {
  clearTimeout(expiryTimer); expiryTimer = null;
  const focusedContent = content.contains(document.activeElement);
  content.replaceChildren(node('p', message, 'queue-message')); content.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  nextCursor = null; next.disabled = true; element('queue-page').textContent = '';
  status.textContent = message; status.dataset.state = state;
  if (focusedContent && state !== 'loading') status.focus({preventScroll:true});
}
function focusLocation() {
  const active = document.activeElement;
  const article = active?.closest('.candidate');
  return article ? {ref: article.dataset.candidateRef, link: active.classList.contains('source-link')} : null;
}
async function refresh(moveToResults = false) {
  const location = focusLocation();
  const requestGeneration = ++generation; pending?.abort();
  const controller = new AbortController(); pending = controller;
  const started = performance.now();
  clear('Loading the fictional source queue…', 'loading');
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const query = new URLSearchParams({view:view.value, limit:limit.value}); if (currentCursor) query.set('cursor', currentCursor);
    const response = await fetch('/dev/source-queue/preview?' + query, {cache:'no-store', credentials:'omit', redirect:'error', signal:controller.signal});
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) throw Error('Unavailable');
    const body = await response.text(); if (body.length > 150000) throw Error('Unavailable');
    const data = JSON.parse(body);
    if (requestGeneration !== generation || document.hidden) return;
    if (!validDisplay(data) || performance.now() >= started + data.validForMs) throw Error('Unavailable');
    content.replaceChildren();
    if (data.entries.length) for (const row of data.entries) content.append(candidate(row));
    else content.append(node('p', 'No fictional candidates match this view. Choose another view or return to the first page.', 'queue-message'));
    content.setAttribute('aria-busy','false'); nextCursor = data.nextCursor; next.disabled = nextCursor === null;
    element('queue-as-of').textContent = formattedDate(data.asOf); element('queue-as-of').dateTime = data.asOf;
    element('queue-page').textContent = `Page ${pageNumber} · ${data.entries.length} candidate${data.entries.length === 1 ? '' : 's'}`;
    status.textContent = data.entries.length ? `${data.entries.length} fictional candidates loaded. ${data.retentionReviewRequired ? 'Retention review blocks editorial use.' : 'Historical fixture; inspection only.'}` : 'No fictional candidates in this view.';
    status.dataset.state = data.entries.length ? 'ready' : 'empty';
    expiryTimer = setTimeout(() => clear('Queue metadata expired. Refresh to inspect the historical fixture again.', 'expired'), Math.max(1, started + data.validForMs - performance.now()));
    if (moveToResults) element('queue-results-heading').focus();
    else if (location) {
      const article = [...content.querySelectorAll('.candidate')].find(item => item.dataset.candidateRef === location.ref);
      (article?.querySelector(location.link ? '.source-link' : 'h3') ?? status).focus({preventScroll:true});
    }
  } catch { if (requestGeneration === generation && !document.hidden) { clear('Queue unavailable. Refresh or return to the first page to try again.', 'unavailable'); if (location) status.focus({preventScroll:true}); } }
  finally { clearTimeout(timeout); if (pending === controller) pending = null; }
}
function first(moveToResults = false) { currentCursor = null; pageNumber = 1; refresh(moveToResults); }
view.addEventListener('change', () => first()); limit.addEventListener('change', () => first());
element('queue-refresh').addEventListener('click', () => refresh()); element('queue-first').addEventListener('click', () => first(true));
next.addEventListener('click', () => { if (nextCursor) { currentCursor = nextCursor; pageNumber++; refresh(true); } });
function suspend() { generation++; pending?.abort(); pending = null; clear('Queue metadata cleared while this page is inactive.', 'inactive'); }
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else refresh(); });
window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', () => refresh());
if (document.readyState === 'complete') refresh();
