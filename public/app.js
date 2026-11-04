import { stories } from './stories.js';
const el = id => document.getElementById(id);
const node = (tag, text, className) => { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; };
const date = value => { const d = new Date(value); return Number.isNaN(d.valueOf()) ? 'Unavailable' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
el('year').textContent = String(new Date().getFullYear());
el('clock').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago' }).format(new Date());
const storyContainer = el('stories');
stories.forEach((story, index) => {
  const card = node('article', '', `story-card story-${index + 1}`); card.id = story.anchor;
  const meta = node('div', `${story.label}  /  DEMONSTRATION`, 'story-meta');
  const title = node('h3', ''); const link = node('a', story.title); link.href = `#article/${story.id}`; title.append(link);
  const summary = node('p', story.summary); const footer = node('div', '', 'story-footer');
  footer.append(node('span', 'Dayline sample · Jan 1, 2026'), node('span', 'READ STORY ↗'));
  card.append(meta, title, summary, footer); storyContainer.append(card);
});
function showRoute() {
  const match = location.hash.match(/^#article\/([a-z-]+)$/); const story = match && stories.find(item => item.id === match[1]);
  const article = el('article-view'); el('home-view').hidden = !!story; article.hidden = !story;
  if (story) {
    const back = node('a', '← Back to the edition', 'back-link'); back.href = '#top-stories';
    const kicker = node('p', `${story.section.toUpperCase()} / DEMONSTRATION STORY`, 'eyebrow');
    const title = node('h1', story.title); const intro = node('p', story.summary, 'article-intro');
    const meta = node('p', `Dayline sample · Published ${date(story.date)} · Updated ${date(story.date)}`, 'article-meta');
    const notice = node('p', 'Fictional demonstration. This is not a current event or published report.', 'demo-notice');
    const content = document.createElement('div'); content.className = 'article-body';
    for (const [heading, text] of [['What happened', story.happened], ['Why it matters', story.matters], ['What remains uncertain', story.uncertain]]) content.append(node('h2', heading), node('p', text));
    content.append(node('h2', 'References'), node('p', 'General background only; this reference does not report the fictional example.'));
    const reference = node('a', story.source); reference.href = story.reference; reference.target = '_blank'; reference.rel = 'noopener noreferrer'; content.append(reference, node('h2', 'Corrections'), node('p', 'No corrections. This is a demonstration placeholder.'));
    article.replaceChildren(back, kicker, title, intro, meta, notice, content); article.focus(); window.scrollTo(0, 0);
  } else if (location.hash && !match) {
    requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());
  }
}
window.addEventListener('hashchange', showRoute); showRoute();
const menu = el('menu-button'), navigation = el('navigation');
menu.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') === 'true'; menu.setAttribute('aria-expanded', String(!open)); navigation.classList.toggle('open', !open); });
navigation.addEventListener('click', event => { if (event.target.closest('a')) { menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('open'); } });
function setState(id, message, className = 'info') { el(id).replaceChildren(node('p', message, className)); }
async function loadJSON(url) { const response = await fetch(url, { headers: { Accept: 'application/json' } }); if (!response.ok) throw Error('Official feed unavailable'); return response.json(); }
function dollars(value) { if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return 'Unavailable'; const [whole, cents = ''] = value.split('.'); return '$' + BigInt(whole).toLocaleString('en-US') + '.' + cents.padEnd(2, '0'); }
async function loadDebt() {
  setState('debt', 'Checking the latest official Treasury record…', 'loading');
  try { const { data, stale, cachedAt } = await loadJSON('/api/debt'); el('debt').replaceChildren(node('p', dollars(data.total), 'value'), node('p', 'Reported as of ' + data.asOf, 'info'), node('p', 'Debt held by public: ' + dollars(data.heldByPublic), 'info'), node('p', 'Intragovernmental: ' + dollars(data.intragovernmental), 'info'), node('p', (stale ? 'STALE · update delayed' : 'FRESH') + ' · Retrieved ' + date(data.fetchedAt || cachedAt), 'status')); }
  catch { setState('debt', 'Unavailable · No figure is displayed until a valid Treasury record is retrieved.', 'error'); }
}
async function loadWeather() {
  const city = el('city').value; setState('weather', `Checking the official ${city} forecast…`, 'loading');
  try { const { data, stale, cachedAt } = await loadJSON('/api/weather?city=' + encodeURIComponent(city)); if (el('city').value !== city) return;
    const children = [node('p', `${Math.round(data.temperatureF)}°F · ${data.period}`, 'value'), node('p', data.description, 'info'), node('p', data.wind ? 'Wind: ' + data.wind : 'Wind detail unavailable', 'info'), node('p', (stale ? 'STALE · update delayed' : 'FRESH') + ' · Retrieved ' + date(data.fetchedAt || cachedAt), 'status')];
    if (data.sourceUpdatedAt) children.push(node('p', 'NWS updated ' + date(data.sourceUpdatedAt), 'info')); el('weather').replaceChildren(...children);
  } catch { if (el('city').value === city) setState('weather', 'Unavailable · The National Weather Service forecast could not be retrieved.', 'error'); }
}
el('city').addEventListener('change', loadWeather); loadDebt(); loadWeather();
