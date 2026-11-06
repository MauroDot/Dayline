"""Offline Chromium checks for the gated fictional edition preview.

Run with the existing browser suite: python -m unittest discover -s tests/browser -v.
Requires Playwright, Chromium, and AXE_PATH (default: the session's local axe bundle).
Zoom checks cover CSS enlargement and reduced-viewport equivalents, not native browser zoom.
"""
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
BASE = 'http://127.0.0.1:34822'
SECTION_IDS = ['TOP_STORIES', 'US', 'WORLD', 'POLITICS_GOVERNMENT', 'BUSINESS_MARKETS', 'TECHNOLOGY', 'SCIENCE', 'HEALTH']
AXE_PATH = Path(os.environ.get('AXE_PATH', '/tmp/dayline-axe/node_modules/axe-core/axe.min.js'))


class EditionBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server_log = open('/tmp/dayline-004b-edition-browser-server.log', 'w')
        cls.server = subprocess.Popen(
            ['node', '--experimental-strip-types', 'server.ts'], cwd=ROOT,
            env={**os.environ, 'PORT': '34822', 'NODE_ENV': 'development', 'DAYLINE_DEV_EDITION': 'fictional'},
            stdout=cls.server_log, stderr=subprocess.STDOUT,
        )
        cls.play = sync_playwright().start()
        try:
            cls.browser = cls.play.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'],
            )
            for _ in range(100):
                try:
                    with urllib.request.urlopen(BASE + '/dev/edition/preview', timeout=1) as response:
                        cls.display = json.load(response)
                    if cls.display and cls.display.get('sections'):
                        break
                except Exception:
                    if cls.server.poll() is not None:
                        raise RuntimeError('Edition server exited; inspect /tmp/dayline-004b-edition-browser-server.log')
                    time.sleep(.1)
            else:
                raise RuntimeError('Gated fictional edition did not become available')
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
        # All browser traffic stays local. Official API reads are replaced even if a test visits home.
        self.context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE + '/') else route.abort())
        self.page = self.context.new_page()
        self.page.route('**/api/**', lambda route: route.fulfill(status=503, json={'error': 'Unavailable in browser fixture'}))
        self.page.goto(BASE + '/dev/edition', wait_until='networkidle')
        self.wait_state('ready')

    def tearDown(self):
        self.context.close()

    def wait_state(self, state):
        self.page.wait_for_function(
            'state => document.querySelector("#edition-status")?.dataset.state === state', arg=state, timeout=10000,
        )

    def mock_display(self, display, status=200, wait='ready'):
        self.page.unroute('**/dev/edition/preview*')
        self.page.route('**/dev/edition/preview*', lambda route: route.fulfill(status=status, json=display))
        self.page.reload(wait_until='domcontentloaded')
        if wait:
            self.wait_state(wait)

    def display_copy(self):
        value = copy.deepcopy(self.display)
        value['validForMs'] = 15000
        return value

    def assert_cleared(self):
        self.assertEqual(self.page.locator('#edition-content .edition-card').count(), 0)
        self.assertEqual(self.page.locator('#edition-content .source-list a').count(), 0)
        self.assertEqual(self.page.locator('#edition-navigation a').count(), 0)
        for selector in ['#edition-date', '#edition-timezone', '#edition-state', '#edition-review', '#edition-revision']:
            self.assertFalse((self.page.locator(selector).text_content() or '').strip(), selector)

    def assert_reflow(self):
        overflow = self.page.evaluate('''() => ({width:innerWidth, scroll:document.documentElement.scrollWidth,
            elements:[...document.querySelectorAll('body *')].map(element => ({
                tag:element.tagName, id:element.id, classes:element.className,
                left:element.getBoundingClientRect().left, right:element.getBoundingClientRect().right
            })).filter(element => element.right > innerWidth + 1 || element.left < -1).slice(0,10)})''')
        self.assertLessEqual(overflow['scroll'], overflow['width'] + 1, json.dumps(overflow))
        self.assertFalse(self.page.evaluate('document.body.scrollWidth > document.body.clientWidth + 1'))
        self.assertFalse(self.page.locator('.context-heading').evaluate_all('elements => elements.some(element => element.scrollWidth > element.clientWidth + 1)'))
        self.assertTrue(self.page.locator('#edition-refresh').is_visible())

    def test_featured_sections_attribution_uncertainty_counterevidence_and_audio_placeholder(self):
        self.assertEqual(self.page.locator('#edition-content > section').count(), 8)
        for section_id in SECTION_IDS:
            self.assertEqual(self.page.locator('#edition-section-' + section_id).count(), 1)
        self.assertEqual(self.page.locator('.edition-card.featured').count(), 1)
        self.assertEqual(self.page.locator('#edition-section-TOP_STORIES .edition-card.featured').count(), 1)
        self.assertGreater(self.page.locator('.section-empty').count(), 0)
        self.assertGreaterEqual(self.page.locator('.source-list a').count(), 2)
        self.assertGreater(self.page.locator('.uncertainty-list').count(), 0)
        self.assertGreater(self.page.locator('.counterevidence').count(), 0)
        text = self.page.locator('#edition-content').inner_text()
        placements = [row for section in self.display['sections'] for row in section['placements']]
        for row in placements:
            self.assertIn(row['headline'], text)
            for source in row['sources']:
                self.assertIn(source['publisher'], text)
            for uncertainty in row['uncertainties']:
                self.assertIn(uncertainty, text)
            if row['counterevidence']['recorded']:
                self.assertIn(row['counterevidence']['label'], text)
        for link in self.page.locator('.source-list a').all():
            self.assertTrue(link.get_attribute('href').startswith('https://'))
            if link.get_attribute('target') == '_blank':
                self.assertIn('noopener', link.get_attribute('rel') or '')
        self.assertIn(self.display['reviewLabel'], self.page.locator('#edition-review').inner_text())
        self.assertIn('Audio briefing — coming soon', self.page.inner_text('body'))
        self.assertEqual(self.page.locator('audio, video').count(), 0)
        self.assertEqual(self.page.get_by_role('button', name='Play', exact=True).count(), 0)
        self.assertEqual(self.page.get_by_role('button', name='Listen', exact=True).count(), 0)

    def test_responsive_390_768_1440_1920_and_artifacts(self):
        for width in [390, 768, 1440, 1920]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 1000})
                self.assert_reflow()
                self.assertEqual(self.page.locator('#edition-content > section').count(), 8)
                self.assertTrue(self.page.locator('.edition-card.featured').is_visible())
                if width == 390:
                    self.page.screenshot(path='/tmp/dayline-004b-mobile.png', full_page=True)
                if width == 1440:
                    self.page.screenshot(path='/tmp/dayline-004b-desktop.png', full_page=True)

    def test_200_400_percent_css_enlargement_and_viewport_equivalent_reflow(self):
        initial_height = self.page.locator('h1').bounding_box()['height']
        measurements = []
        for factor in [2, 4]:
            with self.subTest(factor=factor):
                self.page.set_viewport_size({'width': 1440 // factor, 'height': 1000})
                self.assert_reflow()
                measurements.append({'kind': 'viewport-equivalent', 'factor': factor, **self.page.evaluate('({innerWidth, dpr:devicePixelRatio})')})
                self.page.set_viewport_size({'width': 1440, 'height': 1000})
                self.page.evaluate('factor => document.documentElement.style.zoom = String(factor)', factor)
                self.assertEqual(float(self.page.evaluate('getComputedStyle(document.documentElement).zoom')), factor)
                self.assertGreaterEqual(self.page.locator('h1').bounding_box()['height'], initial_height * factor * .95)
                self.assert_reflow()
                measurements.append({'kind': 'CSS-enlargement', 'factor': factor, **self.page.evaluate('({innerWidth, dpr:devicePixelRatio})')})
                if factor == 4:
                    self.page.screenshot(path='/tmp/dayline-004b-zoom400.png', full_page=True)
                self.page.evaluate('document.documentElement.style.zoom = "1"')
        print('Edition reflow evidence (native browser zoom remains unverified): ' + json.dumps(measurements))

    def test_keyboard_skip_section_navigation_focus_and_reduced_motion(self):
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator('.skip-link').evaluate('element => document.activeElement === element'))
        self.assertGreater(self.page.locator(':focus-visible').count(), 0)
        self.page.keyboard.press('Enter')
        self.page.wait_for_function('document.activeElement.id === "edition-main"')
        for section_id in ['US', 'HEALTH', 'TOP_STORIES']:
            link = self.page.locator('#edition-navigation a[href="#edition-section-' + section_id + '"]')
            link.focus()
            self.page.keyboard.press('Enter')
            self.page.wait_for_function('id => document.activeElement.id === "edition-heading-" + id', arg=section_id)
            self.assertGreater(self.page.locator(':focus-visible').count(), 0)
        self.assertTrue(self.page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'))
        self.assertEqual(self.page.evaluate('getComputedStyle(document.documentElement).scrollBehavior'), 'auto')
        durations = self.page.locator('*').evaluate_all('elements => elements.map(element => ({animation:getComputedStyle(element).animationDuration, transition:getComputedStyle(element).transitionDuration}))')
        for value in durations:
            self.assertTrue(all(float(part.strip().removesuffix('s')) <= .01 for part in value['animation'].split(',')))
            self.assertTrue(all(float(part.strip().removesuffix('s')) <= .01 for part in value['transition'].split(',')))

    def test_response_text_is_inert_and_unsafe_source_urls_are_not_clickable(self):
        value = self.display_copy()
        row = next(row for section in value['sections'] for row in section['placements'])
        marker = '<img src=x onerror="window.__editionXss=1">'
        row['headline'] = marker
        row['summary'] = '<svg onload="window.__editionXss=2">fictional test marker</svg>'
        self.mock_display(value)
        self.assertIn(marker, self.page.locator('#edition-content').inner_text())
        self.assertEqual(self.page.locator('#edition-content img, #edition-content svg, #edition-content script, #edition-content iframe').count(), 0)
        self.assertIsNone(self.page.evaluate('window.__editionXss'))
        unsafe = self.display_copy()
        next(row for section in unsafe['sections'] for row in section['placements'])['sources'][0]['url'] = 'javascript:window.__editionXss=3'
        self.mock_display(unsafe, wait='unavailable')
        self.assert_cleared()
        self.assertEqual(self.page.locator('a[href^="javascript:"]').count(), 0)
        self.assertIsNone(self.page.evaluate('window.__editionXss'))

    def test_refresh_loading_and_upstream_retention_failure_clear_all_cached_content(self):
        pending = []
        self.page.route('**/dev/edition/preview*', lambda route: pending.append(route))
        self.page.locator('#edition-refresh').click()
        # A warm recheck may retain still-authorized content until its existing deadline.
        self.page.wait_for_function('document.querySelector("#edition-content").getAttribute("aria-busy") === "true"')
        self.assertGreater(self.page.locator('.edition-card').count(), 0)
        self.assertEqual(len(pending), 1)
        pending[0].fulfill(status=503, json={'error': 'PRIVATE_RETENTION_REVIEWER_DETAIL'})
        self.wait_state('unavailable')
        self.assert_cleared()
        self.assertNotIn('PRIVATE_RETENTION_REVIEWER_DETAIL', self.page.inner_text('body'))
        self.page.locator('#edition-refresh').click()
        self.wait_state('loading')
        self.assert_cleared()
        self.assertEqual(len(pending), 2)
        pending[1].fulfill(status=503, json={'error': 'Unavailable'})
        self.wait_state('unavailable')
        self.assert_cleared()

    def test_invalidated_preview_never_renders_its_retained_payload(self):
        value = self.display_copy()
        headline = next(row for section in value['sections'] for row in section['placements'])['headline']
        value['status'] = 'INVALIDATED'
        value['sections'] = []
        self.mock_display(value, wait='invalidated')
        self.assert_cleared()
        self.assertNotIn(headline, self.page.locator('#edition-content').text_content() or '')
        # A malformed invalidated response that still carries licensed prose must also fail closed.
        retained = self.display_copy()
        retained['status'] = 'INVALIDATED'
        self.mock_display(retained, wait='unavailable')
        self.assert_cleared()

    def test_expiry_clears_visible_and_hidden_payload_and_refresh_can_recover(self):
        self.page.clock.install()
        value = self.display_copy()
        value['validForMs'] = 1000
        self.mock_display(value)
        self.assertGreater(self.page.locator('.edition-card').count(), 0)
        self.page.clock.fast_forward(1001)
        self.wait_state('expired')
        self.assert_cleared()
        self.page.unroute('**/dev/edition/preview*')
        self.page.route('**/dev/edition/preview*', lambda route: route.fulfill(json=self.display_copy()))
        self.page.locator('#edition-refresh').click()
        self.wait_state('ready')
        self.assertGreater(self.page.locator('.edition-card').count(), 0)

    def test_identical_ttl_renewals_preserve_section_and_source_keyboard_focus(self):
        self.page.clock.install()
        self.mock_display(self.display_copy())
        heading = self.page.locator('#edition-heading-TOP_STORIES')
        heading.focus()
        heading.evaluate('element => window.__focusedEditionNode = element')
        with self.page.expect_response('**/dev/edition/preview*'):
            self.page.clock.fast_forward(10001)
        self.page.wait_for_function('document.querySelector("#edition-content").getAttribute("aria-busy") === "false"')
        self.assertTrue(heading.evaluate('element => document.activeElement === element && window.__focusedEditionNode === element'))
        source = self.page.locator('.source-list a').first
        source.focus()
        source.evaluate('element => window.__focusedEditionNode = element')
        with self.page.expect_response('**/dev/edition/preview*'):
            self.page.clock.fast_forward(10001)
        self.page.wait_for_function('document.querySelector("#edition-content").getAttribute("aria-busy") === "false"')
        self.assertTrue(source.evaluate('element => document.activeElement === element && window.__focusedEditionNode === element'))
        self.wait_state('ready')

    def test_allowlisted_read_only_display_leaks_no_storage_reviewers_or_internal_ids(self):
        dto = self.display
        self.assertEqual(set(dto), {'fictional', 'developmentOnly', 'publiclyPublished', 'date', 'timezone', 'revision', 'status', 'reviewLabel', 'validForMs', 'sections'})
        self.assertIs(dto['fictional'], True)
        self.assertIs(dto['developmentOnly'], True)
        self.assertIs(dto['publiclyPublished'], False)
        for key in ['"storyId"', '"sourceId"', '"policyId"', '"snapshotDigest"', '"actorAssertion"', '"audit"']:
            self.assertNotIn(key, json.dumps(dto))
        self.assertEqual(self.page.evaluate('localStorage.length'), 0)
        self.assertEqual(self.page.evaluate('sessionStorage.length'), 0)
        self.assertEqual(self.page.evaluate('document.cookie'), '')
        self.assertEqual(self.page.evaluate('async () => (await indexedDB.databases()).length'), 0)
        self.assertEqual(self.page.locator('form, input, select, textarea').count(), 0)
        self.assertEqual(self.page.locator('a[href*="stripe"], a[href*="checkout"]').count(), 0)
        self.assertEqual(self.page.locator('[data-story-id], [data-source-id], [data-reviewer]').count(), 0)

    def test_targeted_axe_loaded_empty_and_unavailable_states(self):
        self.assertTrue(AXE_PATH.is_file(), 'Install the local axe bundle or set AXE_PATH before this optional browser suite')
        axe_source = AXE_PATH.read_text()
        for state in ['loaded', 'empty', 'unavailable']:
            with self.subTest(state=state):
                if state == 'empty':
                    value = self.display_copy()
                    for section in value['sections']:
                        section['placements'] = []
                    self.mock_display(value)
                    self.assertEqual(self.page.locator('.section-empty').count(), 8)
                if state == 'unavailable':
                    self.mock_display({'error': 'Unavailable'}, status=503, wait='unavailable')
                    self.assert_cleared()
                self.page.evaluate(axe_source)
                violations = self.page.evaluate('''async () => (await axe.run(document, {
                    runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']}
                })).violations.map(value => ({id:value.id, impact:value.impact, targets:value.nodes.map(node => node.target)}))''')
                self.assertEqual(violations, [], json.dumps(violations))


if __name__ == '__main__':
    unittest.main()
