"""Optional UI checks: python -m unittest discover -s tests/browser -v (requires Playwright and Chromium)."""
import os
import subprocess
import time
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]

class BrowserUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = subprocess.Popen(['node', '--experimental-strip-types', 'server.ts'], cwd=ROOT, env={**os.environ, 'PORT': '34821'}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.play = sync_playwright().start()
        cls.browser = cls.play.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        for _ in range(50):
            try:
                page = cls.browser.new_page()
                page.goto('http://127.0.0.1:34821', wait_until='domcontentloaded', timeout=1000)
                page.close()
                break
            except Exception:
                time.sleep(.1)
        else:
            raise RuntimeError('Server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.play.stop(); cls.server.terminate(); cls.server.wait(timeout=5)

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        self.page = self.context.new_page()
        self.page.route('**/api/debt', lambda route: route.fulfill(json={'data': {'total': '300.00', 'heldByPublic': '220.00', 'intragovernmental': '80.00', 'asOf': '2026-01-01', 'fetchedAt': '2026-01-02T00:00:00Z'}, 'stale': True, 'cachedAt': '2026-01-02T00:00:00Z'}))
        self.page.route('**/api/weather?*', lambda route: route.fulfill(status=503, json={'error': 'Unavailable'}))
        self.page.goto('http://127.0.0.1:34821', wait_until='networkidle')

    def tearDown(self): self.context.close()

    def test_stories_article_and_attribution(self):
        self.assertEqual(self.page.locator('.story-card').count(), 4)
        self.assertIn('not current events', self.page.locator('#top-stories').inner_text())
        self.page.locator('.story-card a').first.click()
        self.assertTrue(self.page.locator('#article-view').is_visible())
        self.assertIn('Fictional demonstration', self.page.locator('#article-view').inner_text())
        self.assertIn('What remains uncertain', self.page.locator('#article-view').inner_text())
        self.assertIn('epa.gov', self.page.locator('#article-view a[target="_blank"]').get_attribute('href'))
        self.page.locator('.back-link').click()
        self.page.locator('#home-view').wait_for(state='visible')
        self.assertTrue(self.page.locator('#home-view').is_visible())

    def test_official_data_and_unavailable_features(self):
        self.assertIn('$300.00', self.page.locator('#debt').inner_text())
        self.assertIn('STALE', self.page.locator('#debt').inner_text())
        self.assertIn('Unavailable', self.page.locator('#weather').inner_text())
        self.assertTrue(self.page.locator('.audio-controls button').is_disabled())
        self.assertIn('AI-generated', self.page.locator('#briefing').inner_text())
        self.assertIn('provisional', self.page.locator('#plus').inner_text())
        self.assertIn('Unavailable', self.page.locator('#markets').inner_text())

    def test_weather_city_selection(self):
        calls = []
        def weather(route):
            calls.append(route.request.url)
            route.fulfill(json={'data': {'period': 'Tonight', 'temperatureF': 40, 'description': 'Clear', 'wind': '5 mph', 'fetchedAt': '2026-01-02T00:00:00Z', 'sourceUpdatedAt': '2026-01-01T23:00:00Z'}, 'stale': False})
        self.page.unroute('**/api/weather?*')
        self.page.route('**/api/weather?*', weather)
        self.page.select_option('#city', label='Chicago')
        self.page.wait_for_function("document.querySelector('#weather').textContent.includes('Tonight')")
        self.assertIn('Chicago', calls[0]); self.assertIn('NWS updated', self.page.locator('#weather').inner_text())

    def test_responsive_navigation_and_screenshots(self):
        out = Path('/tmp/dayline-dl001c-screenshots'); out.mkdir(exist_ok=True)
        for width in [1440, 768, 390]:
            self.page.set_viewport_size({'width': width, 'height': 900})
            self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth > innerWidth'), f'overflow at {width}')
            self.page.screenshot(path=str(out / f'dayline-{width}.png'), full_page=True)
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator(':focus-visible').count() > 0)
        button = self.page.locator('#menu-button')
        self.assertTrue(button.is_visible()); button.focus(); self.page.keyboard.press('Enter')
        self.assertEqual(button.get_attribute('aria-expanded'), 'true')
        self.page.get_by_role('navigation', name='Main navigation').get_by_role('link', name='Weather').click()
        self.assertEqual(button.get_attribute('aria-expanded'), 'false')
        self.assertEqual(self.page.evaluate('location.hash'), '#weather-section')
        self.assertEqual(self.page.evaluate("getComputedStyle(document.documentElement).scrollBehavior"), 'auto')

if __name__ == '__main__': unittest.main()
