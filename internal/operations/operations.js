/* Private development interface. Credentials and action snapshots live only in this closure. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { credential: null, generation: 0, controllers: new Set(), timer: null, leaseTimer: null,
    busy: false, connecting: false, refreshVersion: 0, overview: null, page: null, detail: null, detailId: null, staleDetail: false,
    stories: null, editions: null, cursor: null, view: 'RECENT', limit: 6, selected: new Map(), selection: null, selectionVersion: 0, signatures: new Map(), leases: new Map(), requests: new Map() };
  const reviewNames = { begin: 'Begin review', propose: 'Recommend provenance', confirm: 'Confirm independently', reject: 'Reject recommendation', hold: 'Place review hold', release: 'Release review hold', withdraw: 'Withdraw source' };
  const sourceIdPattern = /^url-[a-f0-9]{64}$/;
  const revisionPattern = /^[a-f0-9]{64}$/;
  const messages = { 400: 'The request was not accepted. Check the required fields and explicit selections.', 401: 'The session is no longer authorized. Reconnect explicitly.', 403: 'This operation is not permitted for the current account and exact resource.', 404: 'This assigned resource is unavailable.', 409: 'The source or workflow revision changed, or this action is no longer eligible. Refresh explicitly and review it again.', 413: 'The request exceeds the development interface limit.', 429: 'The development listener is busy. Wait before trying again.', 503: 'The authorized view is temporarily unavailable.' };
  class RequestError extends Error { constructor(status) { super(messages[status] || 'The authorized request could not be completed.'); this.status = status; } }
  function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; }
  function replace(id, ...nodes) { $(id).replaceChildren(...nodes); }
  function notice(text, kind = 'ready') { $('global-status').textContent = text; $('global-status').dataset.state = kind; }
  function error(text) { $('global-error').textContent = text; $('global-error').hidden = !text; }
  function empty(text) { return element('p', text, 'empty'); }
  function tag(text, blocked = false) { return element('span', text, blocked ? 'status-label blocked' : 'status-label'); }
  function button(text, id, handler, disabled = false) { const node = element('button', text); node.type = 'button'; node.id = id; node.disabled = disabled; node.addEventListener('click', handler); return node; }
  function fields(rows) { const dl = element('dl', undefined, 'label-value'); for (const [name, value] of rows) { dl.append(element('dt', name), element('dd', value ?? 'Withheld or unavailable')); } return dl; }
  function safeLink(raw) {
    if (typeof raw !== 'string') return element('span', 'Link withheld');
    try { const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password) return element('span', 'Link withheld'); const a = element('a', raw); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.referrerPolicy = 'no-referrer'; return a; } catch { return element('span', 'Link withheld'); }
  }
  function selectedValues(id) { return [...$(id).querySelectorAll('input[type=checkbox]:checked')].map(input => input.value); }
  function checks(id, rows, selected = []) {
    const old = new Set(selected), fragment = document.createDocumentFragment();
    if (!rows.length) fragment.append(empty('No currently authorized options on this page.'));
    for (const row of rows) { const label = element('label', undefined, 'check'); const input = document.createElement('input'); input.type = 'checkbox'; input.id = `${id}-${row.sourceId}`; input.value = row.sourceId; input.checked = old.has(row.sourceId); input.setAttribute('aria-label', row.metadata.publisher || row.sourceId); label.append(input, element('span', `${row.metadata.publisher || 'Assigned source'} · ${row.sourceId}`)); fragment.append(label); }
    $(id).replaceChildren(fragment);
  }
  function preserveFocus(render) {
    const active = document.activeElement, activeId = active?.id;
    const start = active && 'selectionStart' in active ? active.selectionStart : null;
    const end = active && 'selectionEnd' in active ? active.selectionEnd : null;
    render();
    if (activeId && active !== document.activeElement && $(activeId) && !$(activeId).disabled) { $(activeId).focus({ preventScroll: true }); if (start !== null && ['INPUT', 'TEXTAREA'].includes($(activeId).tagName)) { try { $(activeId).setSelectionRange(start, end); } catch { /* Non-text input. */ } } }
  }
  function stopRequests() { clearTimeout(state.timer); clearTimeout(state.leaseTimer); state.timer = null; state.leaseTimer = null; for (const controller of state.controllers) controller.abort(); state.controllers.clear(); }
  function clearSelection(text = 'No validated source revisions.') {
    state.selectionVersion++; state.selection = null; $('selection-validity').textContent = text; $('prepare-story').disabled = true;
  }
  function clearDetail(text = 'Choose Inspect on an assigned source.', keepId = false) {
    state.requests.set('detail', (state.requests.get('detail') || 0) + 1);
    state.detail = null; state.signatures.delete('detail'); state.leases.delete('detail');
    if (!keepId) state.detailId = null;
    state.staleDetail = keepId; replace('detail-content'); $('detail-state').textContent = text; $('review-form').hidden = true;
    replace('review-actions'); replace('review-evidence'); replace('review-origin', new Option('Choose an authorized origin', ''));
    $('detail-refresh').hidden = !keepId;
  }
  function clearProtected() {
    state.overview = null; state.page = null; state.stories = null; state.editions = null;
    state.signatures.clear(); state.leases.clear(); state.selected.clear(); state.cursor = null;
    clearDetail(); clearSelection();
    replace('overview-content', empty('No current authorized overview.')); replace('source-list'); replace('story-list'); replace('edition-list');
    replace('selected-sources'); replace('support-sources', empty('Select sources above first.')); replace('contradict-sources', empty('Select sources above first.'));
    delete $('support-sources').dataset.selection;
    replace('edition-story', new Option('Choose a currently approved revision', '')); $('selected-state').textContent = 'No sources selected.';
    $('source-state').textContent = 'No current authorized source view.'; $('source-next').disabled = true; $('validate-sources').disabled = true; $('assemble-edition').disabled = true;
  }
  function disconnect(text = 'Disconnected. Protected records and authored drafts have been cleared.', kind = 'disconnected') {
    state.generation++; stopRequests(); state.credential = null; state.busy = false; state.connecting = false;
    clearProtected(); $('story-form').reset(); $('edition-form').reset(); $('review-form').reset(); $('development-credential').value = '';
    $('workspace').hidden = true; $('connect').disabled = false; $('disconnect').disabled = true;
    $('connection-state').textContent = text; notice(text, kind); error('');
  }
  function guardGeneration(generation) { if (!state.credential || generation !== state.generation || document.visibilityState === 'hidden') throw new DOMException('Stale request', 'AbortError'); }
  async function request(path, body, generation = state.generation) {
    guardGeneration(generation);
    const controller = new AbortController(); state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${state.credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      guardGeneration(generation);
      if (!response.ok) { if (response.status === 401) disconnect(messages[401], 'denied'); throw new RequestError(response.status); }
      const value = await response.json(); guardGeneration(generation); return value;
    } finally { clearTimeout(timeout); state.controllers.delete(controller); }
  }
  function lease(name, value, started) {
    if (!value || typeof value !== 'object' || !Number.isFinite(Date.parse(value.asOf)) || !Number.isFinite(value.validForMs) || value.validForMs <= 0 || value.validForMs > 1500) throw new RequestError(503);
    const expiry = started + Math.min(value.validForMs, 1500);
    if (expiry <= performance.now()) throw new RequestError(503);
    state.leases.set(name, expiry); armLease();
  }
  function armLease() {
    clearTimeout(state.leaseTimer);
    if (!state.leases.size) return;
    const earliest = Math.min(...state.leases.values());
    state.leaseTimer = setTimeout(() => {
      if (!state.credential || state.busy) return;
      if (Math.min(...state.leases.values()) <= performance.now()) disconnect('The authorized view expired. Protected records and drafts were cleared; reconnect explicitly.', 'expired'); else armLease();
    }, Math.max(0, earliest - performance.now() + 1));
  }
  function changed(name, value) { const { asOf, validForMs, ...data } = value; const signature = JSON.stringify(data); if (state.signatures.get(name) === signature) return false; state.signatures.set(name, signature); return true; }
  function denySection(name, text, kind) {
    state.signatures.delete(name); state.leases.delete(name);
    if (name === 'overview') { state.overview = null; replace('overview-content', empty(text)); }
    if (name === 'sources') { state.page = null; state.selected.clear(); clearDetail(); clearSelection('Source access changed. Validate a fresh explicit selection.'); renderSelected(); replace('source-list', empty(text)); $('source-list').dataset.state = kind; $('source-state').textContent = text; $('source-next').disabled = true; }
    if (name === 'stories') { state.stories = null; replace('story-list', empty(text)); $('story-list').dataset.state = kind; populateEditionStories(); }
    if (name === 'editions') { state.editions = null; replace('edition-list', empty(text)); $('edition-list').dataset.state = kind; }
    if (name === 'detail') clearDetail(text);
  }
  async function projection(name, path, body, apply, generation) {
    const started = performance.now();
    const sequence = (state.requests.get(name) || 0) + 1; state.requests.set(name, sequence);
    try { const value = await request(path, body, generation); if (sequence !== state.requests.get(name)) return; lease(name, value, started); apply(value, changed(name, value)); }
    catch (failure) {
      if (generation !== state.generation || !state.credential || sequence !== state.requests.get(name)) return;
      if (failure.name === 'AbortError') { denySection(name, 'The authorized request timed out. Refresh to try again.', 'unavailable'); return; }
      const text = name === 'sources' && failure.status === 409 ? 'The authorized source page changed. Choose First page to reload the current view.' : failure.message || 'The authorized view is unavailable.';
      denySection(name, text, failure.status === 403 ? 'denied' : 'unavailable');
      if (name === 'overview') disconnect('Current authorization could not be verified. Protected records and drafts were cleared.', failure.status === 403 ? 'denied' : 'unavailable');
    }
  }
  async function refresh() {
    if (!state.credential || state.busy || document.visibilityState === 'hidden') return;
    clearTimeout(state.timer);
    const generation = state.generation;
    const refreshVersion = ++state.refreshVersion;
    const query = { view: state.view, limit: state.limit, ...(state.cursor ? { cursor: state.cursor } : {}) };
    await Promise.all([
      projection('overview', '/internal/operations/overview', {}, (value, didChange) => { state.overview = value; if (didChange) renderOverview(); }, generation),
      projection('sources', '/internal/operations/sources', query, (value, didChange) => { state.page = value.page; if (didChange) preserveFocus(renderSources); }, generation),
      projection('stories', '/internal/operations/stories', {}, (value, didChange) => { state.stories = value.stories; if (didChange) preserveFocus(renderStories); }, generation),
      projection('editions', '/internal/operations/editions', {}, (value, didChange) => { state.editions = value.editions; if (didChange) preserveFocus(renderEditions); }, generation),
      ...(state.detailId && !state.staleDetail ? [projection('detail', '/internal/operations/source', { sourceId: state.detailId }, (value, didChange) => {
        if (state.detail && state.detail.review.revision !== value.review.revision) { clearDetail('This source revision changed. Your authored text is preserved. Refresh this source explicitly before another decision.', true); clearSelection('A source revision changed. Validate your selected sources again.'); notice('Source revision changed; explicit refresh is required.', 'stale'); }
        else { state.detail = value; if (didChange) preserveFocus(renderDetail); }
      }, generation)] : [])
    ]);
    if (generation !== state.generation || refreshVersion !== state.refreshVersion || !state.credential) return;
    if ($('global-status').dataset.state === 'loading') notice('Authorized views loaded. Review each action explicitly.', 'ready');
    state.timer = setTimeout(refresh, 850);
  }
  function renderOverview() {
    const value = state.overview; if (!value) return;
    replace('overview-content', fields([['Current roles', value.roles.join(', ') || 'None'], ['Role permissions', value.permissions.join(', ') || 'None'], ['Fictional evaluation timestamp (UTC)', value.asOf]]), element('p', 'Permissions also require exact resource assignments. The interface does not expose unassigned work counts.', 'small'), element('p', 'The fictional harness uses a fixed historical evaluation clock. This timestamp does not assert current real-world source rights. Browser view expiry is measured separately using elapsed time.', 'small'));
    $('assemble-edition').disabled = !value.permissions.includes('EDITION_ASSEMBLE');
    renderSelected();
  }
  function renderSources() {
    const page = state.page;
    if (!page || !Array.isArray(page.entries)) { denySection('sources', 'Invalid authorized source response.', 'unavailable'); return; }
    const permitted = new Map(page.entries.map(row => [row.sourceId, row]));
    for (const [id, prior] of state.selected) {
      const current = permitted.get(id);
      if (!current || !current.handoffEligible || JSON.stringify(current) !== JSON.stringify(prior)) { state.selected.delete(id); clearSelection('The source view changed. Review and validate your selection again.'); }
    }
    const fragment = document.createDocumentFragment();
    for (const row of page.entries) {
      const metadata = row.metadata, card = element('article', undefined, 'card source-card'); card.dataset.sourceId = row.sourceId;
      card.append(element('h3', metadata.publisher || 'Assigned source metadata withheld'), tag(`Review: ${metadata.review?.status || 'UNREVIEWED'}`), tag(row.handoffEligible ? 'Story handoff eligible' : 'Story handoff blocked', !row.handoffEligible));
      card.append(fields([['Provenance', `${metadata.provenance} · ${metadata.provenanceStatus}`], ['Rights', metadata.rightsStatus], ['Retention', metadata.retentionStatus], ['Blocked reason', metadata.blockedReason || 'None reported'], ['Published (UTC)', metadata.publishedAt]]));
      const link = element('p'); link.append(safeLink(metadata.canonicalUrl)); card.append(link);
      const ref = element('p', row.sourceId, 'source-reference'); card.append(ref);
      const actions = element('div', undefined, 'actions'); actions.append(button('Inspect source', `inspect-${row.sourceId}`, () => inspectSource(row.sourceId)));
      const label = element('label', undefined, 'check'), input = document.createElement('input'); input.type = 'checkbox'; input.id = `select-${row.sourceId}`; input.checked = state.selected.has(row.sourceId); input.disabled = !row.handoffEligible; input.setAttribute('aria-label', `Select ${metadata.publisher || 'assigned source'} for story preparation`);
      input.addEventListener('change', () => {
        if (input.checked && state.selected.size >= 8) { input.checked = false; error('Select at most eight sources.'); return; }
        if (input.checked) state.selected.set(row.sourceId, row); else state.selected.delete(row.sourceId);
        clearSelection('Selection changed. Validate the exact sources again.'); renderSelected();
      }); label.append(input, element('span', row.handoffEligible ? 'Select for human-authored story' : 'Unavailable for story preparation')); actions.append(label); card.append(actions); fragment.append(card);
    }
    if (!page.entries.length) fragment.append(empty('No assigned sources in this view. No unassigned record count is disclosed.'));
    $('source-list').replaceChildren(fragment); $('source-list').dataset.state = page.entries.length ? 'ready' : 'empty';
    $('source-state').textContent = `${page.view}: ${page.entries.length} assigned sources shown.${page.retentionReviewRequired ? ' Retention review blocks advancement.' : ''}`;
    $('source-next').disabled = !page.nextCursor; renderSelected();
    if (state.detail) refreshProofOptions();
  }
  async function inspectSource(id) {
    if (!sourceIdPattern.test(id) || !state.credential) return;
    clearDetail('Loading current authorized source…'); state.detailId = id; state.staleDetail = false;
    const generation = state.generation;
    await projection('detail', '/internal/operations/source', { sourceId: id }, value => { if (state.detailId !== id) return; state.detail = value; renderDetail(); $('detail-heading').focus({ preventScroll: true }); }, generation);
  }
  function refreshProofOptions() {
    const proof = (state.page?.entries || []).filter(row => row.proofEligible);
    const selected = selectedValues('review-evidence'), origin = $('review-origin').value;
    checks('review-evidence', proof, selected);
    const options = [new Option('Choose an authorized origin', ''), ...proof.filter(row => row.sourceId !== state.detailId).map(row => new Option(`${row.metadata.publisher || 'Authorized source'} · ${row.sourceId}`, row.sourceId))];
    $('review-origin').replaceChildren(...options); if (options.some(option => option.value === origin)) $('review-origin').value = origin;
  }
  function renderDetail() {
    const value = state.detail; if (!value) return;
    $('detail-state').textContent = `Current state: ${value.review.status}. Exact review revision ${value.review.reviewRevision}.`;
    const nodes = [fields([['Assigned source', value.sourceId], ['Publisher', value.metadata.publisher], ['Provenance', value.metadata.provenance], ['Independent resolution', value.review.independentlyResolved ? 'Confirmed independently' : 'Not independently resolved'], ['Handoff', value.handoffEligible ? 'Currently eligible; server revalidation required' : 'Blocked']])];
    if (value.proposal) nodes.push(fields([['Pending recommendation', value.proposal.classification], ['Reason', value.proposal.reasonCode], ['Authorized evidence references', value.proposal.evidenceReferences.join(', ')], ['Authorized origin', value.proposal.originId || 'Not syndicated']]));
    replace('detail-content', ...nodes); $('review-form').hidden = false; $('detail-refresh').hidden = false;
    refreshProofOptions();
    const actions = [];
    for (const action of Object.keys(reviewNames)) actions.push(button(reviewNames[action], `review-${action}`, () => reviewAction(action), !value.actions[action]));
    replace('review-actions', ...actions);
    $('review-independence').textContent = value.review.pendingProposal && !value.actions.confirm ? 'Independent confirmation is unavailable for this account or revision. The recommending identity cannot confirm its own recommendation; switch to a separately authorized independent reviewer.' : 'Recommendation and independent confirmation are separate. The server checks current identity, exact revision and evidence again.';
  }
  function renderSelected() {
    const rows = [...state.selected.values()];
    $('selected-state').textContent = rows.length ? `${rows.length} explicitly selected source${rows.length === 1 ? '' : 's'}.` : 'No sources selected.';
    replace('selected-sources', ...rows.map(row => element('p', `${row.metadata.publisher || 'Assigned source'} · ${row.sourceId}`, 'source-reference')));
    $('validate-sources').disabled = !rows.length || !state.overview?.permissions.includes('STORY_CREATE');
    const support = selectedValues('support-sources'), contradict = selectedValues('contradict-sources');
    // The same projection may renew frequently. Preserve explicit citation choices while it is unchanged.
    const ids = rows.map(row => row.sourceId).join('|');
    if ($('support-sources').dataset.selection !== ids) { checks('support-sources', rows, support); checks('contradict-sources', rows, contradict); $('support-sources').dataset.selection = ids; }
    $('prepare-story').disabled = !state.selection || !rows.length || !state.overview?.permissions.includes('STORY_CREATE');
  }
  async function reviewAction(action) {
    const detail = state.detail; if (!detail || !detail.actions[action]) return;
    const references = selectedValues('review-evidence'), reason = $('review-reason').value, classification = $('classification').value;
    if (!references.length || !reason) { error('Choose at least one explicit evidence reference and a decision reason.'); return; }
    const body = { sourceId: detail.sourceId, revision: detail.review.revision, reasonCode: reason, evidenceReferences: references };
    if (action === 'propose') { if (!classification || (classification === 'SYNDICATED' && !$('review-origin').value)) { error('Choose a classification and, for syndication, an explicit authorized origin.'); return; } body.classification = classification; body.originId = classification === 'SYNDICATED' ? $('review-origin').value : null; }
    await mutate(`/internal/source-review/${action}`, body, `${reviewNames[action]} for the exact inspected source?`, 'The source decision was accepted. Inspect the refreshed source before another action.');
  }
  async function validateSelection() {
    const ids = [...state.selected.keys()]; if (!ids.length) return;
    const generation = state.generation; error(''); clearSelection('Checking exact current source revisions…');
    const selectionVersion = state.selectionVersion;
    try {
      const value = await request('/internal/source-handoff/inspect', { sourceIds: ids }, generation);
      if (selectionVersion !== state.selectionVersion || ids.length !== state.selected.size || ids.some(id => !state.selected.has(id))) return;
      if (!Array.isArray(value) || value.length !== ids.length || value.some(row => !sourceIdPattern.test(row.id) || !revisionPattern.test(row.revision)) || new Set(value.map(row => row.id)).size !== ids.length || value.some(row => !state.selected.has(row.id))) throw new RequestError(503);
      state.selection = value.map(row => ({ id: row.id, revision: row.revision })); $('selection-validity').textContent = `${value.length} exact source revisions validated. Every preparation revalidates them at commit.`; renderSelected(); notice('Selected source revisions validated. Supply your own story, claim and explicit evidence choices.');
    } catch (failure) { if (generation !== state.generation || selectionVersion !== state.selectionVersion) return; clearSelection('Source validation was denied or stale. Your authored text is preserved.'); error(failure.message); notice('Selected sources could not be validated.', failure.status === 409 ? 'stale' : 'denied'); }
  }
  function renderStories() {
    const rows = state.stories || [], fragment = document.createDocumentFragment();
    for (const story of rows) {
      const card = element('article', undefined, 'card'); card.dataset.storyId = story.id;
      card.append(element('h3', story.headline || 'Story content withheld'), tag(story.status, story.blocked), fields([['Story ID', story.id], ['Exact version', story.version], ['Current eligibility', story.blocked ? 'Blocked; licensed text unavailable' : 'Current assigned revision']]));
      if (story.summary) card.append(element('p', story.summary));
      for (const evidence of story.evidence) { const group = element('div', undefined, 'story-evidence'); group.append(element('p', evidence.claim), fields([['Verification', evidence.verification], ['Uncertainty', evidence.uncertainty], ['Supporting sources', evidence.support.join(', ') || 'None'], ['Contradicting sources', evidence.contradict.join(', ') || 'None']])); card.append(group); }
      const actions = element('div', undefined, 'actions');
      for (const status of story.actions.reviewStatuses) actions.append(button(`Review: ${status.replaceAll('_', ' ')}`, `story-review-${story.id}-${status}`, () => mutate(`/internal/stories/${encodeURIComponent(story.id)}/review`, { version: story.version, status }, `Move this exact story revision to ${status}?`, `Story review accepted: ${status}. Approval remains a separate action.`)));
      actions.append(button('Approve exact story revision', `story-approve-${story.id}`, () => mutate(`/internal/stories/${encodeURIComponent(story.id)}/approve`, { version: story.version }, 'Approve this exact story revision as managing editor? This does not publish it.', 'Story approval accepted. No publication occurred.'), !story.actions.approve)); card.append(actions); fragment.append(card);
    }
    if (!rows.length) fragment.append(empty('No currently readable assigned stories. Creation does not grant implicit ownership.'));
    $('story-list').replaceChildren(fragment); $('story-list').dataset.state = rows.length ? 'ready' : 'empty'; populateEditionStories();
  }
  function populateEditionStories() {
    const prior = $('edition-story').value;
    const options = [new Option('Choose a currently approved revision', ''), ...(state.stories || []).filter(story => !story.blocked && story.status === 'APPROVED').map(story => new Option(`${story.headline || story.id} · version ${story.version}`, story.id))];
    $('edition-story').replaceChildren(...options); if (options.some(option => option.value === prior)) $('edition-story').value = prior;
  }
  function renderEditions() {
    const rows = state.editions || [], fragment = document.createDocumentFragment();
    for (const edition of rows) {
      const card = element('article', undefined, 'card'); card.dataset.editionId = edition.id;
      card.append(element('h3', `${edition.date} · ${edition.timezone}`), tag(edition.status, !edition.available), fields([['Edition ID', edition.id], ['Exact revision', edition.revision], ['Assigned story placements', edition.storyCount], ['Publication authority', 'None']]));
      const actions = element('div', undefined, 'actions');
      for (const status of edition.actions.reviewStatuses) actions.append(button(`Edition review: ${status.replaceAll('_', ' ')}`, `edition-review-${edition.id}-${status}`, () => mutate(`/internal/editions/${encodeURIComponent(edition.id)}/review`, { revision: edition.revision, status }, `Move this exact edition revision to ${status}? This grants no publication authority.`, `Edition review accepted: ${status}. No publication occurred.`)));
      card.append(actions); fragment.append(card);
    }
    if (!rows.length) fragment.append(empty('No currently readable assigned editions. Assembly does not grant implicit ownership.'));
    $('edition-list').replaceChildren(fragment); $('edition-list').dataset.state = rows.length ? 'ready' : 'empty';
  }
  async function mutate(path, body, question, success) {
    if (state.busy || !state.credential || !window.confirm(question)) return false;
    const priorFocusId = document.activeElement?.id;
    state.busy = true; state.generation++; stopRequests(); const generation = state.generation;
    error(''); notice('Submitting an explicit, server-checked editorial action…', 'loading');
    // Never reuse a source action token or validated handoff after any mutation attempt.
    // A long-running mutation must not keep expired read projections visible.
    clearProtected();
    try {
      await request(path, body, generation); notice(success, 'ready'); return true;
    } catch (failure) {
      if (generation === state.generation && state.credential) {
        const message = path === '/internal/source-handoff/prepare' && failure.status === 400
          ? 'Story preparation was rejected. Check your explicit fields and evidence, then inspect current source eligibility and validate a fresh selection. Your authored text is preserved.'
          : failure.message || 'The action outcome could not be confirmed. Refresh and inspect before retrying.';
        error(message); notice(failure.status === 409 ? 'The action is stale or ineligible. Your authored text is preserved.' : 'The action was not accepted or its outcome could not be confirmed.', failure.status === 409 ? 'stale' : failure.status === 403 ? 'denied' : 'unavailable');
      }
      return false;
    } finally {
      if (generation === state.generation && state.credential) {
        state.busy = false; await refresh();
        // A committed action can remove its old revision button. Restore a useful keyboard destination,
        // while leaving any field the user has chosen during the request undisturbed.
        if (document.activeElement === document.body) {
          const previous = priorFocusId ? $(priorFocusId) : null;
          const source = body.sourceId ? $(`inspect-${body.sourceId}`) : null;
          const destination = previous && !previous.disabled ? previous : source || $('global-status');
          destination.focus({ preventScroll: true });
        }
      }
    }
  }
  async function connect(event) {
    event.preventDefault(); if (state.connecting) return;
    const manual = $('development-credential').value; $('development-credential').value = '';
    disconnect('Connecting to the trusted development listener…', 'loading'); state.connecting = true; $('connect').disabled = true;
    const generation = state.generation;
    try {
      // Local navigation fragments contain no authority; the trusted binding accepts the exact shell URL.
      if (location.hash) history.replaceState(null, '', location.pathname);
      const credential = typeof window.daylineDevelopmentCredential === 'function' ? await window.daylineDevelopmentCredential($('fixture-role').value) : manual;
      if (generation !== state.generation) return;
      if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential) || credential.length > 8192) { disconnect('A trusted ephemeral development credential is required.', 'denied'); return; }
      state.credential = credential; state.connecting = false; $('disconnect').disabled = false; $('workspace').hidden = false;
      $('connection-state').textContent = 'Connected in this page’s memory only. Current roles and exact assignments are checked by the listener.';
      await refresh();
    } catch { if (generation === state.generation) disconnect('The trusted local development connection is unavailable.', 'unavailable'); }
  }
  $('connection-form').addEventListener('submit', connect);
  $('disconnect').addEventListener('click', () => { disconnect(); $('connect').focus(); });
  $('fixture-role').addEventListener('change', () => { if (state.credential || state.connecting) disconnect('Account selection changed. Reconnect explicitly; prior protected records and drafts were cleared.'); });
  $('refresh-all').addEventListener('click', () => { error(''); notice('Refreshing current authorized work…', 'loading'); refresh(); });
  $('source-filter').addEventListener('submit', event => { event.preventDefault(); state.view = $('source-view').value; state.limit = Number($('source-limit').value); state.cursor = null; state.selected.clear(); clearSelection(); clearDetail(); state.signatures.delete('sources'); refresh(); });
  $('source-first').addEventListener('click', () => { state.cursor = null; state.selected.clear(); clearSelection(); clearDetail(); state.signatures.delete('sources'); refresh(); });
  $('source-next').addEventListener('click', () => { if (!state.page?.nextCursor) return; state.cursor = state.page.nextCursor; state.selected.clear(); clearSelection(); clearDetail(); state.signatures.delete('sources'); refresh(); });
  $('detail-refresh').addEventListener('click', () => { if (state.detailId) inspectSource(state.detailId); });
  $('validate-sources').addEventListener('click', validateSelection);
  $('clear-selection').addEventListener('click', () => { state.selected.clear(); clearSelection(); state.signatures.delete('sources'); renderSelected(); if (state.page) renderSources(); });
  $('use-view-time').addEventListener('click', () => { if (state.overview) $('story-first-seen').value = state.overview.asOf; });
  $('review-form').addEventListener('submit', event => event.preventDefault());
  $('story-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!$('story-form').reportValidity() || !state.selection || !state.overview) return;
    const support = selectedValues('support-sources'), contradict = selectedValues('contradict-sources');
    if (support.some(id => contradict.includes(id))) { error('A source cannot be both explicitly supporting and contradicting this one claim. Review your selections.'); return; }
    if ($('evidence-verified').checked && !support.length) { error('Explicit verification requires at least one explicitly selected supporting source.'); return; }
    if (state.selection.some(row => !support.includes(row.id) && !contradict.includes(row.id))) { error('Explicitly identify whether each selected source supports or contradicts your claim. The interface never invents citations.'); return; }
    const firstSeenAt = $('story-first-seen').value.trim(), eventAt = $('story-event').value.trim();
    const utc = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
    if (!utc(firstSeenAt) || eventAt && !utc(eventAt)) { error('Use a valid explicit UTC timestamp, for example YYYY-MM-DDTHH:mm:ss.sssZ.'); return; }
    const story = { id: $('story-id').value.trim(), headline: $('story-headline').value.trim(), topic: $('story-topic').value.trim(), summary: $('story-summary').value.trim(), geography: $('story-geography').value.trim(), eventAt: eventAt || null, firstSeenAt, updatedAt: state.overview.asOf, clusterId: $('story-cluster').value.trim(), evidence: [{ id: $('evidence-id').value.trim(), claim: $('evidence-claim').value.trim(), support, contradict, verification: $('evidence-verified').checked ? 'VERIFIED' : 'UNVERIFIED', uncertainty: $('evidence-uncertainty').value.trim(), reviewerDecisions: [] }], sourceIds: state.selection.map(row => row.id) };
    const sources = state.selection.map(row => ({ ...row }));
    await mutate('/internal/source-handoff/prepare', { sources, story }, 'Prepare this human-authored story in INGESTED state using the exact selected source revisions? No approval or publication is requested.', 'Human-authored story preparation accepted in INGESTED state. Review and approval remain separate. Your draft text is preserved.');
  });
  $('edition-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!$('edition-form').reportValidity()) return;
    const story = (state.stories || []).find(row => row.id === $('edition-story').value && row.status === 'APPROVED' && !row.blocked);
    if (!story) { error('Choose a currently approved, readable assigned story revision.'); return; }
    const body = { date: $('edition-date').value, timezone: $('edition-timezone').value.trim(), placements: [{ storyId: story.id, storyVersion: story.version, section: $('edition-section').value, featured: $('edition-featured').checked }] };
    await mutate('/internal/editions', body, 'Assemble this explicitly dated edition using the selected approved story revision? It will remain ASSEMBLING, without publication authority.', 'Edition assembly accepted in ASSEMBLING state. New edition access still requires exact assignment.');
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') disconnect('The page became hidden. Protected records and authored drafts were cleared; reconnect explicitly.'); });
  window.addEventListener('pagehide', () => disconnect());
  const fixture = typeof window.daylineDevelopmentCredential === 'function'; $('fixture-connection').hidden = !fixture; $('manual-connection').hidden = fixture;
  disconnect('Disconnected. No protected records have been loaded.');
})();
