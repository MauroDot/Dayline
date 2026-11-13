"""Deterministic, offline browser checks for the fictional historical source queue."""
import copy
import json
import os
import subprocess
import time
import unittest
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = 'http://127.0.0.1:34823'
AXE_PATH = Path(os.environ.get('AXE_PATH', '/tmp/dayline-axe/node_modules/axe-core/axe.min.js'))


class SourceQueueBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server_log = open('/tmp/dayline-007a-queue-browser-server.log', 'w')
        cls.server = subprocess.Popen(
            ['node', '--experimental-strip-types', 'server.ts'], cwd=ROOT,
            env={**os.environ, 'PORT': '34823', 'NODE_ENV': 'development', 'DAYLINE_DEV_SOURCE_QUEUE': 'fictional'},
            stdout=cls.server_log, stderr=subprocess.STDOUT,
        )
        cls.play = sync_playwright().start()
        try:
            cls.browser = cls.play.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
            for _ in range(100):
                try:
                    with urllib.request.urlopen(BASE + '/dev/source-queue/preview', timeout=1) as response:
                        cls.display = json.load(response)
                    if cls.display.get('entries'):
                        break
                except Exception:
                    if cls.server.poll() is not None:
                        raise RuntimeError('Fictional queue server exited; inspect /tmp/dayline-007a-queue-browser-server.log')
                    time.sleep(.1)
            else:
                raise RuntimeError('Fictional source queue did not become available')
        except Exception:
            if hasattr(cls, 'browser'):
                cls.browser.close()
            cls.play.stop()
            cls.server.terminate()
            cls.server.wait(timeout=5)
            cls.server_log.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.play.stop()
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.server_log.close()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        self.external_requests = []

        def local_only(route):
            if route.request.url.startswith(BASE + '/'):
                route.continue_()
            else:
                self.external_requests.append(route.request.url)
                route.abort()

        self.context.route('**/*', local_only)
        self.page = self.context.new_page()
        self.page.route('**/api/**', lambda route: route.fulfill(status=503, json={'error': 'No official requests in fictional browser tests'}))
        self.page.goto(BASE + '/dev/source-queue', wait_until='networkidle')
        self.wait_state('ready')

    def tearDown(self):
        self.assertEqual(self.external_requests, [], 'The queue must not request any external source')
        self.context.close()

    def wait_state(self, state):
        self.page.wait_for_function('state => document.querySelector("#queue-status").dataset.state === state', arg=state, timeout=10000)

    def mock(self, value, status=200, state='ready'):
        self.page.unroute('**/dev/source-queue/preview*')
        self.page.route('**/dev/source-queue/preview*', lambda route: route.fulfill(status=status, json=value))
        self.page.reload(wait_until='domcontentloaded')
        self.wait_state(state)

    def assert_cleared(self):
        self.assertEqual(self.page.locator('.candidate, .source-link').count(), 0)
        self.assertEqual(self.page.locator('#queue-page').inner_text(), '')
        self.assertTrue(self.page.locator('#queue-next').is_disabled())

    def assert_reflow(self):
        dimensions = self.page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
        self.assertLessEqual(dimensions['scroll'], dimensions['width'] + 1, json.dumps(dimensions))
        self.assertFalse(self.page.evaluate('document.body.scrollWidth > document.body.clientWidth + 1'))
        self.assertTrue(self.page.locator('#queue-refresh').is_visible())

    def test_historical_statuses_attribution_and_no_approval_or_browser_storage(self):
        text = self.page.inner_text('body')
        self.assertIn('fictional · development only · historical fixture', text.lower())
        self.assertIn('2026', self.page.locator('#queue-as-of').inner_text())
        self.assertIn('cannot approve, advance or publish', text)
        self.assertGreater(self.page.locator('.candidate').count(), 0)
        self.assertGreater(self.page.locator('.badge').count(), 0)
        self.assertIn('Quarantine: Quarantined', text)
        self.assertIn('Quarantine: Not quarantined', text)
        self.assertIn('Quarantine: Withheld', text)
        self.assertGreater(self.page.locator('.blocked-reason').count(), 0)
        for link in self.page.locator('.source-link').all():
            self.assertTrue(link.get_attribute('href').startswith('https://source-queue.example.test/'))
            self.assertIn('noopener', link.get_attribute('rel'))
            self.assertIn('noreferrer', link.get_attribute('rel'))
        self.assertEqual(self.page.locator('button').count(), 3)
        self.assertEqual(self.page.locator('input, textarea, audio, video').count(), 0)
        self.assertEqual(self.page.evaluate('localStorage.length + sessionStorage.length'), 0)
        self.assertEqual(self.page.evaluate('document.cookie'), '')
        self.assertEqual(self.page.evaluate('async () => (await indexedDB.databases()).length'), 0)

    def test_named_filters_show_rights_provenance_syndication_and_withholding(self):
        for view in ['UNRESOLVED', 'RELATED', 'ELIGIBLE', 'BLOCKED', 'WITHDRAWN', 'RECENT']:
            with self.subTest(view=view):
                self.page.select_option('#queue-view', view)
                self.wait_state('ready')
                text = self.page.locator('#queue-content').inner_text()
                if view == 'UNRESOLVED':
                    self.assertTrue('Unresolved' in text or 'Disputed' in text)
                    self.assertIn('Quarantine: Quarantined', text)
                if view == 'RELATED':
                    self.assertIn('Verified syndicated copy', text)
                    self.assertIn('not independent reporting', text)
                if view == 'ELIGIBLE':
                    self.assertIn('eligible managed metadata', text.lower())
                    self.assertEqual(self.page.locator('.candidate:not(.eligible)').count(), 0)
                if view == 'WITHDRAWN':
                    self.assertIn('Source metadata withheld', text)
                    self.assertIn('Quarantine: Withheld', text)
                    self.assertEqual(self.page.locator('.source-link').count(), 0)

    def test_bounded_pagination_first_page_and_focus_after_page_change(self):
        self.page.select_option('#queue-limit', '3')
        self.wait_state('ready')
        self.assertEqual(self.page.locator('.candidate').count(), 3)
        first = self.page.locator('.candidate').evaluate_all('items => items.map(item => item.dataset.candidateRef)')
        self.page.locator('#queue-next').click()
        self.wait_state('ready')
        self.assertIn('Page 2', self.page.locator('#queue-page').inner_text())
        second = self.page.locator('.candidate').evaluate_all('items => items.map(item => item.dataset.candidateRef)')
        self.assertFalse(set(first) & set(second))
        self.assertTrue(self.page.locator('#queue-results-heading').evaluate('element => document.activeElement === element'))
        self.page.locator('#queue-first').click()
        self.wait_state('ready')
        self.assertIn('Page 1', self.page.locator('#queue-page').inner_text())
        self.assertEqual(first, self.page.locator('.candidate').evaluate_all('items => items.map(item => item.dataset.candidateRef)'))

    def test_keyboard_skip_native_filters_focus_and_refresh_restore_source_focus(self):
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator('.skip-link').evaluate('element => document.activeElement === element'))
        self.page.keyboard.press('Enter')
        self.page.wait_for_function('document.activeElement.id === "queue-main"')
        self.page.locator('#queue-view').focus()
        self.page.keyboard.press('ArrowDown')
        self.wait_state('ready')
        self.assertEqual(self.page.locator('#queue-view').input_value(), 'UNRESOLVED')
        self.assertTrue(self.page.locator('#queue-view').evaluate('element => document.activeElement === element'))
        self.assertGreater(self.page.locator(':focus-visible').count(), 0)
        self.page.select_option('#queue-view', 'RECENT')
        self.wait_state('ready')
        link = self.page.locator('.source-link').first
        href = link.get_attribute('href')
        link.focus()
        self.page.evaluate('document.querySelector("#queue-refresh").click()')
        self.wait_state('ready')
        self.assertEqual(self.page.evaluate('document.activeElement.getAttribute("href")'), href)
        self.assertTrue(self.page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'))

    def test_mobile_desktop_and_css_enlargement_reflow(self):
        for width in [320, 390, 768, 1440, 1920]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 1000})
                self.assert_reflow()
                if width in [390, 1440]:
                    self.page.screenshot(path=f'/tmp/dayline-007a-source-queue-{width}.png', full_page=True)
        for factor in [2, 4]:
            self.page.set_viewport_size({'width': 1440, 'height': 1000})
            self.page.evaluate('factor => document.documentElement.style.zoom = String(factor)', factor)
            self.assert_reflow()
            self.page.evaluate('document.documentElement.style.zoom = "1"')

    def test_empty_unavailable_loading_and_stale_cursor_recovery(self):
        empty = copy.deepcopy(self.display)
        empty['entries'] = []
        empty['nextCursor'] = None
        self.mock(empty, state='empty')
        self.assertEqual(self.page.locator('.candidate, .source-link').count(), 0)
        self.assertTrue(self.page.locator('#queue-next').is_disabled())
        self.assertIn('No fictional candidates', self.page.locator('#queue-content').inner_text())
        pending = []
        self.page.unroute('**/dev/source-queue/preview*')
        self.page.route('**/dev/source-queue/preview*', lambda route: pending.append(route))
        self.page.locator('#queue-refresh').click()
        self.wait_state('loading')
        self.assert_cleared()
        pending[0].fulfill(status=503, json={'error': 'PRIVATE_CURSOR_IDENTITY'})
        self.wait_state('unavailable')
        self.assert_cleared()
        self.assertNotIn('PRIVATE_CURSOR_IDENTITY', self.page.inner_text('body'))
        self.page.unroute('**/dev/source-queue/preview*')
        self.page.locator('#queue-first').click()
        self.wait_state('ready')

    def test_inert_text_and_unsafe_or_revoked_metadata_fail_closed(self):
        value = copy.deepcopy(self.display)
        marker = '<img src=x onerror="window.__queueXss=1">'
        row = next(row for row in value['entries'] if row['publisher'])
        row['publisher'] = marker
        self.mock(value)
        self.assertIn(marker, self.page.locator('#queue-content').inner_text())
        self.assertEqual(self.page.locator('#queue-content img, #queue-content svg, #queue-content script').count(), 0)
        self.assertIsNone(self.page.evaluate('window.__queueXss'))
        for changes in [{'canonicalUrl': 'javascript:window.__queueXss=2'}, {'rightsStatus': 'REVOKED', 'sourceEligible': False, 'blockedReason': 'POLICY_REVOKED'}, {'quarantineStatus': 'RELEASED'}, {'quarantineStatus': 'WITHHELD'}, {'canAdvance': True}]:
            bad = copy.deepcopy(self.display)
            row = next(row for row in bad['entries'] if row['publisher'])
            row.update(changes)
            self.mock(bad, state='unavailable')
            self.assert_cleared()
            self.assertIsNone(self.page.evaluate('window.__queueXss'))

    def test_expiry_and_inactive_page_clear_all_payload_and_refresh_recovers(self):
        self.page.clock.install()
        value = copy.deepcopy(self.display)
        value['validForMs'] = 1000
        self.mock(value)
        self.page.clock.fast_forward(1001)
        self.wait_state('expired')
        self.assert_cleared()
        self.page.unroute('**/dev/source-queue/preview*')
        self.page.locator('#queue-refresh').click()
        self.wait_state('ready')
        self.page.evaluate('window.dispatchEvent(new PageTransitionEvent("pagehide"))')
        self.wait_state('inactive')
        self.assert_cleared()
        self.page.evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow"))')
        self.wait_state('ready')

    def test_targeted_axe_loaded_empty_unavailable_and_expired_states(self):
        self.assertTrue(AXE_PATH.is_file(), 'Install the local axe bundle or set AXE_PATH')
        axe_source = AXE_PATH.read_text()
        for state in ['ready', 'empty', 'unavailable', 'expired']:
            with self.subTest(state=state):
                if state == 'empty':
                    value = copy.deepcopy(self.display)
                    value['entries'] = []
                    value['nextCursor'] = None
                    self.mock(value, state='empty')
                elif state == 'unavailable':
                    self.mock({'error': 'Unavailable'}, status=503, state='unavailable')
                elif state == 'expired':
                    self.page.clock.install()
                    value = copy.deepcopy(self.display)
                    value['validForMs'] = 1000
                    self.mock(value)
                    self.page.clock.fast_forward(1001)
                    self.wait_state('expired')
                self.page.evaluate(axe_source)
                violations = self.page.evaluate('''async () => (await axe.run(document, {
                    runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}
                })).violations.map(row => ({id:row.id,impact:row.impact,targets:row.nodes.map(node => node.target)}))''')
                self.assertEqual(violations, [], json.dumps(violations))


if __name__ == '__main__':
    unittest.main()
