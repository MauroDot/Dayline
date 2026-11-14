"""Offline acceptance for the explicitly enabled internal editorial interface.

Each test owns a disposable fictional Node process. Synthetic credentials cross
only anonymous pipes and a trusted Playwright binding, and stay in memory. No
trace, HAR, video, provider calls, or credential-bearing diagnostic output is used.
CSS enlargement and reduced viewports do not establish native Windows zoom.
"""
import json
import os
import queue
import subprocess
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
AXE_PATH = Path(os.environ.get('AXE_PATH', '/tmp/dayline-axe/node_modules/axe-core/axe.min.js'))


class OperationsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.play = sync_playwright().start()
        try:
            cls.browser = cls.play.chromium.launch(
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                args=['--no-sandbox'],
            )
        except Exception:
            cls.play.stop()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.play.stop()

    def setUp(self):
        self.fixture = subprocess.Popen(
            ['node', '--experimental-strip-types', 'tests/helpers/operations-browser-fixture.ts'],
            cwd=ROOT, env={**os.environ, 'NODE_ENV': 'development'},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', bufsize=1,
        )
        self.lines = queue.Queue()

        def read_private_pipe():
            for line in self.fixture.stdout:
                self.lines.put(line)
            self.lines.put(None)

        self.reader = threading.Thread(target=read_private_pipe, daemon=True)
        self.reader.start()
        self.addCleanup(self.close_fixture)
        self.send({'command': 'start-fictional-acceptance'})
        self.bootstrap = self.receive()
        if self.bootstrap.get('type') != 'bootstrap':
            raise RuntimeError('The isolated fictional acceptance fixture did not initialize')
        self.origin = self.bootstrap['origin']
        self.ids = self.bootstrap['sourceIds']
        self.context = self.browser.new_context(
            viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce',
        )
        self.addCleanup(self.close_context)
        self.external_requests = []
        self.held_routes = []

        def local_only(route):
            if route.request.url.startswith(self.origin + '/'):
                route.continue_()
            else:
                # Store no URL or headers: unexpected requests must not expose secrets.
                self.external_requests.append('blocked external request')
                route.abort()

        self.context.route('**/*', local_only)
        def development_credential(source, role):
            caller = source['frame']
            url = urlsplit(caller.url)
            if (caller != source['page'].main_frame or caller.url != self.origin + '/internal/operations'
                    or url.query or url.fragment or role not in self.bootstrap['accounts']):
                return None
            return self.bootstrap['accounts'][role]['credential']

        self.context.expose_binding('daylineDevelopmentCredential', development_credential)
        self.page = self.context.new_page()
        self.page.goto(self.origin + '/internal/operations', wait_until='domcontentloaded')

    def tearDown(self):
        self.assertEqual(self.external_requests, [], 'The operations UI attempted an external request')

    def close_context(self):
        for route in self.held_routes:
            try:
                route.abort()
            except Exception:
                pass  # The route may already have completed or been aborted on disconnect.
        for page in self.context.pages:
            page.unroute_all(behavior='ignoreErrors')
        self.context.unroute_all(behavior='ignoreErrors')
        self.context.close()

    def hold_route(self, route, bucket):
        bucket.append(route)
        self.held_routes.append(route)

    def wait_held(self, bucket, count=1):
        # Network events and route callbacks arrive separately. Pump the
        # Playwright dispatcher until the callback actually owns the request;
        # this uses a bounded real deadline even when browser time is paused.
        deadline = time.monotonic() + 5
        while len(bucket) < count and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertGreaterEqual(len(bucket), count, 'The expected local request was not intercepted')

    def wait_source_response(self, response):
        self.assertEqual(response.status, 200)
        ids = [row['sourceId'] for row in response.json()['page']['entries']]
        self.page.wait_for_function('ids => JSON.stringify([...document.querySelectorAll("#source-list [data-source-id]")].map(row => row.dataset.sourceId)) === JSON.stringify(ids)', arg=ids)
        return ids

    def send(self, value):
        self.fixture.stdin.write(json.dumps(value) + '\n')
        self.fixture.stdin.flush()

    def receive(self):
        try:
            line = self.lines.get(timeout=20)
            if line is None:
                raise RuntimeError('The isolated fictional fixture ended unexpectedly')
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError('invalid envelope')
            return value
        except (queue.Empty, ValueError):
            # Never include private IPC contents in an assertion or exception.
            raise RuntimeError('The isolated fictional fixture did not return a valid response') from None

    def command(self, name, **values):
        self.send({'command': name, **values})
        result = self.receive()
        self.assertIs(result.get('ok'), True, 'Trusted fictional fixture control failed')
        return result

    def close_fixture(self):
        if self.fixture.poll() is None:
            try:
                self.send({'command': 'dispose'})
                result = self.receive()
                self.assertIs(result.get('ok'), True, 'Fictional fixture cleanup failed')
                self.assertIs(result.get('cleanupRemoved'), True, 'Fictional repository was not removed')
                self.fixture.wait(timeout=10)
            except Exception:
                self.fixture.terminate()
                self.fixture.wait(timeout=10)
                raise
        for stream in [self.fixture.stdin, self.fixture.stdout]:
            if stream:
                stream.close()
        self.reader.join(timeout=2)
        self.bootstrap = None

    def api(self, path, body, role='editor'):
        # Credentials are consumed directly by the local request client in memory.
        # Do not include request objects/headers in unittest assertion messages.
        try:
            response = self.context.request.post(
                self.origin + path, data=body,
                headers={'Authorization': 'Bearer ' + self.bootstrap['accounts'][role]['credential'],
                         'Content-Type': 'application/json', 'Origin': self.origin},
            )
        except Exception:
            raise RuntimeError('The private fictional HTTP request could not complete') from None
        return response.status, response.json()

    def connect(self, role='editor'):
        if self.page.locator('#disconnect').is_enabled():
            self.page.locator('#disconnect').click()
        self.page.select_option('#fixture-role', role)
        self.page.locator('#connect').click()
        self.page.wait_for_function('() => document.querySelector("#global-status").dataset.state === "ready"')
        self.assertTrue(self.page.locator('#workspace').is_visible())

    def refresh(self):
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/operations/sources') as response:
            self.page.locator('#refresh-all').click()
        self.wait_source_response(response.value)
        self.page.wait_for_function('() => document.querySelector("#global-status").dataset.state === "ready"')

    def source(self, name):
        return self.page.locator('[data-source-id="' + self.ids[name] + '"]')

    def inspect(self, name):
        self.page.locator('#inspect-' + self.ids[name]).click()
        self.page.wait_for_function('() => document.querySelector("#detail-content").textContent.length > 0')

    def confirm_click(self, locator, accept=True):
        dialogs = []

        def answer(dialog):
            dialogs.append(dialog.type)
            dialog.accept() if accept else dialog.dismiss()

        self.page.once('dialog', answer)
        locator.click()
        self.assertEqual(dialogs, ['confirm'], 'An explicit consequence confirmation is required')

    def review(self, action, reason, classification=None):
        self.page.select_option('#review-reason', reason)
        if classification:
            self.page.select_option('#classification', classification)
        self.page.locator('#review-evidence input[value="' + self.ids['proof'] + '"]').check()
        path = '/internal/source-review/' + action
        with self.page.expect_response(lambda response: response.url == self.origin + path) as result:
            self.confirm_click(self.page.locator('#review-' + action))
        self.assertEqual(result.value.status, 200)
        self.page.wait_for_function('() => document.querySelector("#global-status").dataset.state === "ready"')
        self.inspect('pending')

    def propose_pending(self):
        self.connect('managing')
        self.inspect('pending')
        self.review('begin', 'INITIAL_REVIEW')
        self.review('propose', 'EVIDENCE_SUPPORTED', 'SECONDARY')

    def select_pending(self):
        self.command('resolve', source='pending')
        self.connect()
        self.page.locator('#select-' + self.ids['pending']).check()
        self.page.locator('#validate-sources').click()
        self.page.wait_for_function('() => !document.querySelector("#prepare-story").disabled')

    def fill_story(self, source='pending'):
        fields = {
            'story-id': self.bootstrap['storyId'], 'story-topic': 'fiction',
            'story-headline': 'A human writes an invented garden proposal',
            'story-summary': 'Human-authored fictional words; <b>literal markup</b> remains text.',
            'story-geography': 'Imaginary Town', 'story-cluster': 'fictional-browser-cluster',
            'story-first-seen': self.bootstrap['asOf'], 'evidence-id': 'human-browser-claim',
            'evidence-claim': 'The invented garden proposal remains a fictional proposal.',
            'evidence-uncertainty': 'This invented example establishes no real-world fact.',
        }
        for field, value in fields.items():
            self.page.locator('#' + field).fill(value)
        self.page.locator('#support-sources input[value="' + self.ids[source] + '"]').check()
        return fields

    def prepare(self):
        self.select_pending()
        fields = self.fill_story()
        self.assertFalse(self.page.locator('#evidence-verified').is_checked())
        self.page.locator('#evidence-verified').check()
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/source-handoff/prepare') as result:
            self.confirm_click(self.page.locator('#prepare-story'))
        self.assertEqual(result.value.status, 200)
        self.page.wait_for_selector('[data-story-id="' + self.bootstrap['storyId'] + '"]')
        return fields

    def assert_no_storage(self):
        self.assertEqual(self.page.evaluate('localStorage.length + sessionStorage.length'), 0)
        self.assertEqual(self.page.evaluate('document.cookie'), '')
        self.assertEqual(len(self.context.cookies()), 0)
        self.assertEqual(self.page.evaluate('async () => (await indexedDB.databases()).length'), 0)

    def assert_reflow(self):
        dimensions = self.page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
        self.assertLessEqual(dimensions['scroll'], dimensions['width'] + 1, json.dumps(dimensions))
        self.assertTrue(self.page.locator('#disconnect').is_visible())
        self.assertTrue(self.page.locator('#source-filter button').is_visible())

    def test_explicit_connection_fictional_labels_and_memory_only_credentials(self):
        self.assertFalse(self.page.locator('#workspace').is_visible())
        self.assertIn('FICTIONAL WORKFLOW', self.page.inner_text('body'))
        self.assertIn('NO PUBLICATION AUTHORITY', self.page.inner_text('body'))
        self.assertTrue(self.page.locator('#fixture-connection').is_visible())
        self.assertEqual(self.page.locator('#fixture-role option').count(), 5)
        self.assertEqual(self.page.locator('#source-list article').count(), 0)
        self.connect()
        self.assertFalse(bool(self.page.locator('#development-credential').input_value()), 'Credential input must be cleared')
        self.assert_no_storage()
        for account in self.bootstrap['accounts'].values():
            self.assertTrue(account['credential'] not in self.page.content(), 'A credential reached the DOM')

    def test_assigned_sources_hide_unassigned_identity_metadata_and_counts(self):
        self.connect()
        self.assertGreaterEqual(self.page.locator('#source-list [data-source-id]').count(), 3)
        body = self.page.inner_text('body')
        self.assertIn('Fictional workflow proof report', body)
        self.assertNotIn('Fictional workflow other report', body)
        self.assertNotIn(self.ids['other'], self.page.content())
        self.assertNotIn('editorial-workflow.example.test/other', self.page.content())
        status, result = self.api('/internal/operations/source', {'sourceId': self.ids['other']})
        self.assertEqual(status, 403)
        self.assertEqual(result['error'], 'FORBIDDEN')
        self.assertNotIn(self.ids['other'], json.dumps(result))

    def test_supported_filters_bounded_pagination_and_empty_view(self):
        self.connect()
        for view in ['UNRESOLVED', 'RELATED', 'ELIGIBLE', 'BLOCKED', 'WITHDRAWN', 'RECENT']:
            with self.subTest(view=view):
                self.page.select_option('#source-view', view)
                with self.page.expect_response(lambda response: response.url == self.origin + '/internal/operations/sources' and response.request.post_data_json.get('view') == view) as response:
                    self.page.locator('#source-filter button').click()
                self.wait_source_response(response.value)
                self.assertNotIn(self.ids['other'], self.page.content())
                if view == 'WITHDRAWN':
                    self.assertEqual(self.page.locator('#source-list').get_attribute('data-state'), 'empty')
                    self.assertIn('No assigned sources', self.page.locator('#source-list').inner_text())
        self.page.select_option('#source-limit', '3')
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/operations/sources' and response.request.post_data_json.get('limit') == 3) as response:
            self.page.locator('#source-filter button').click()
        first = self.wait_source_response(response.value)
        self.assertEqual(len(first), 3)
        self.assertTrue(self.page.locator('#source-next').is_enabled())
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/operations/sources' and 'cursor' in response.request.post_data_json) as response:
            self.page.locator('#source-next').click()
        second = self.wait_source_response(response.value)
        self.assertEqual(len(second), 3)
        self.assertFalse(set(first) & set(second))
        self.assertTrue(self.page.locator('#source-next').is_disabled())
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/operations/sources' and 'cursor' not in response.request.post_data_json) as response:
            self.page.locator('#source-first').click()
        self.wait_source_response(response.value)
        self.assertEqual(first, self.page.locator('#source-list [data-source-id]').evaluate_all('rows => rows.map(row => row.dataset.sourceId)'))

    def test_recommendation_is_not_handoff_and_self_confirmation_is_denied(self):
        self.propose_pending()
        self.assertTrue(self.page.locator('#select-' + self.ids['pending']).is_disabled())
        self.assertTrue(self.page.locator('#review-confirm').count() == 0 or self.page.locator('#review-confirm').is_disabled())
        status, detail = self.api('/internal/operations/source', {'sourceId': self.ids['pending']}, 'managing')
        self.assertEqual(status, 200)
        summary = detail.get('review', detail.get('summary', detail))
        revision = summary.get('revision', detail.get('revision'))
        self.assertTrue(revision)
        status, result = self.api('/internal/source-review/confirm', {
            'sourceId': self.ids['pending'], 'revision': revision, 'reasonCode': 'EVIDENCE_SUPPORTED',
            'evidenceReferences': [self.ids['proof']],
        }, 'managing')
        self.assertEqual(status, 403)
        self.assertEqual(result['error'], 'FORBIDDEN')
        self.assertTrue(self.page.locator('#prepare-story').is_disabled())

    def test_independent_confirmation_enables_explicit_source_validation(self):
        self.propose_pending()
        self.connect('confirming')
        self.inspect('pending')
        self.assertTrue(self.page.locator('#review-confirm').is_enabled())
        self.review('confirm', 'EVIDENCE_SUPPORTED')
        self.connect()
        self.assertTrue(self.page.locator('#select-' + self.ids['pending']).is_enabled())
        self.page.locator('#select-' + self.ids['pending']).check()
        self.assertTrue(self.page.locator('#prepare-story').is_disabled())
        self.page.locator('#validate-sources').click()
        self.page.wait_for_function('() => !document.querySelector("#prepare-story").disabled')
        self.assertEqual(self.page.locator('#evidence-claim').input_value(), '')
        self.assertFalse(self.page.locator('#evidence-verified').is_checked())

    def test_human_authored_preparation_preserves_exact_text_and_only_ingests(self):
        fields = self.prepare()
        row = self.page.locator('[data-story-id="' + self.bootstrap['storyId'] + '"]')
        self.assertIn(fields['story-headline'], row.inner_text())
        self.assertIn(fields['story-summary'], row.inner_text())
        self.assertIn('INGESTED', row.inner_text())
        self.assertEqual(row.locator('b, script, iframe').count(), 0)
        self.assertTrue(self.page.locator('#story-approve-' + self.bootstrap['storyId']).is_disabled())
        status, result = self.api('/internal/operations/stories', {})
        self.assertEqual(status, 200)
        story = next(row for row in result['stories'] if row['id'] == self.bootstrap['storyId'])
        self.assertEqual(story['headline'], fields['story-headline'])
        self.assertEqual(story['summary'], fields['story-summary'])
        self.assertEqual(story['status'], 'INGESTED')
        self.assertEqual(story['version'], 1)

    def test_editor_cannot_approve_and_each_review_transition_is_explicit(self):
        self.prepare()
        story_id = self.bootstrap['storyId']
        status, result = self.api('/internal/stories/' + story_id + '/approve', {'version': 1})
        self.assertEqual(status, 403)
        self.assertEqual(result['error'], 'FORBIDDEN')
        for state in ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW']:
            with self.page.expect_response(lambda response: response.url == self.origin + '/internal/stories/' + story_id + '/review') as result:
                self.confirm_click(self.page.locator('#story-review-' + story_id + '-' + state))
            self.assertEqual(result.value.status, 200)
            self.page.wait_for_function('row => document.querySelector(`[data-story-id="${row.id}"]`)?.textContent.includes(row.status)', arg={'id': story_id, 'status': state})
        self.assertTrue(self.page.locator('#story-approve-' + story_id).is_disabled())
        self.connect('managing')
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/stories/' + story_id + '/approve') as result:
            self.confirm_click(self.page.locator('#story-approve-' + story_id))
        self.assertEqual(result.value.status, 200)
        self.page.wait_for_function('id => document.querySelector(`[data-story-id="${id}"]`)?.textContent.includes("APPROVED")', arg=story_id)

    def test_disputed_and_held_sources_remain_blocked(self):
        self.command('resolve', source='pending')
        self.command('hold', source='pending')
        self.connect()
        for name in ['pending', 'disputed']:
            self.assertTrue(self.page.locator('#select-' + self.ids[name]).is_disabled())
            status, result = self.api('/internal/source-handoff/inspect', {'sourceIds': [self.ids[name]]})
            self.assertIn(status, [400, 403, 409])
            self.assertNotIn('sources', result)
        self.assertTrue(self.page.locator('#prepare-story').is_disabled())

    def test_stale_selection_rejected_without_losing_human_authored_text(self):
        # Keep automatic polling paused while deliberately submitting the old
        # token: the real server, rather than a newer UI snapshot, rejects it.
        self.page.clock.install(time='2026-06-01T12:00:00.000Z')
        self.page.clock.pause_at('2026-06-01T12:00:01.000Z')
        self.select_pending()
        fields = self.fill_story()
        self.page.locator('#evidence-verified').check()
        self.command('hold', source='pending')
        # Exercise the genuine server stale token before the next periodic refresh.
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/source-handoff/prepare') as result:
            self.confirm_click(self.page.locator('#prepare-story'))
        # Existing handoff contract checks current eligibility before token
        # equality: a newly held source is rejected as INVALID_REQUEST (400).
        self.assertEqual(result.value.status, 400)
        status, rejection = self.api('/internal/source-handoff/prepare', result.value.request.post_data_json)
        self.assertEqual(status, 400)
        self.assertEqual(rejection['error'], 'INVALID_REQUEST')
        self.assertEqual(self.page.locator('#story-headline').input_value(), fields['story-headline'])
        self.assertEqual(self.page.locator('#story-summary').input_value(), fields['story-summary'])
        self.assertTrue(self.page.locator('#prepare-story').is_disabled())
        self.assertEqual(self.page.locator('[data-story-id="' + self.bootstrap['storyId'] + '"]').count(), 0)

    def test_revocation_clears_protected_data_and_authority(self):
        self.connect()
        self.page.locator('#story-headline').fill('Auth loss must clear this human draft')
        self.command('revoke', role='editor')
        self.page.wait_for_function('() => document.querySelector("#workspace").hidden', timeout=5000)
        self.assertEqual(self.page.locator('#source-list [data-source-id]').count(), 0)
        self.assertEqual(self.page.locator('#story-headline').input_value(), '')
        self.assertTrue(self.page.locator('#disconnect').is_disabled())
        status, result = self.api('/internal/operations/sources', {})
        self.assertEqual(status, 401)
        self.assertEqual(result['error'], 'UNAUTHENTICATED')

    def test_reporter_and_administrator_receive_no_editorial_records_or_forged_authority(self):
        for role in ['reporter', 'admin']:
            with self.subTest(role=role):
                self.connect(role)
                self.assertEqual(self.page.locator('#source-list [data-source-id]').count(), 0)
                self.assertEqual(self.page.locator('#story-list [data-story-id]').count(), 0)
                self.assertEqual(self.page.locator('#edition-list [data-edition-id]').count(), 0)
                self.assertNotIn('Fictional workflow proof report', self.page.inner_text('body'))
                self.page.evaluate('''() => { const button = document.createElement("button"); button.textContent="Forged approve"; button.id="forged-approval"; document.querySelector("#workspace").append(button); }''')
                status, result = self.api('/internal/stories/' + self.bootstrap['existingStoryId'] + '/approve', {'version': 1}, role)
                self.assertEqual(status, 403)
                self.assertEqual(result['error'], 'FORBIDDEN')

    def test_edition_state_is_visible_but_no_publication_controls_exist(self):
        self.connect()
        self.assertGreater(self.page.locator('#edition-list [data-edition-id]').count(), 0)
        self.assertNotIn('PUBLISHED', self.page.locator('#edition-list').inner_text())
        self.assertEqual(self.page.get_by_role('button', name='Publish', exact=True).count(), 0)
        self.assertEqual(self.page.locator('audio, video').count(), 0)
        self.assertIn('assembly is not publication', self.page.inner_text('body').lower())
        self.assertIn('ASSEMBLING', self.page.locator('#edition-list').inner_text())
        self.page.locator('#edition-date').fill('2026-06-01')
        self.page.locator('#edition-timezone').fill('UTC')
        self.page.select_option('#edition-story', self.bootstrap['existingStoryId'])
        self.page.select_option('#edition-section', 'TOP_STORIES')
        self.page.locator('#edition-featured').check()
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/editions') as result:
            self.confirm_click(self.page.locator('#assemble-edition'))
        self.assertEqual(result.value.status, 200)
        receipt = result.value.json()
        self.assertEqual(receipt['status'], 'ASSEMBLING')
        self.assertEqual(receipt['revision'], 1)
        # The assembly-slot grant does not create review/read ownership of the
        # new UUID; the existing separately assigned edition remains visible.
        status, projected = self.api('/internal/operations/editions', {})
        self.assertEqual(status, 200)
        self.assertNotIn(receipt['id'], [row['id'] for row in projected['editions']])
        self.assertIn(self.bootstrap['existingEditionId'], [row['id'] for row in projected['editions']])

    def test_refresh_cannot_restore_credentials_or_stale_authority(self):
        self.connect()
        self.page.locator('#story-headline').fill('Refresh must discard this draft')
        self.page.reload(wait_until='domcontentloaded')
        self.assertFalse(self.page.locator('#workspace').is_visible())
        self.assertEqual(self.page.locator('#source-list [data-source-id]').count(), 0)
        self.assertEqual(self.page.locator('#story-headline').input_value(), '')
        self.assert_no_storage()
        self.assertTrue(self.page.locator('#disconnect').is_disabled())

    def test_listener_has_no_public_reader_or_bootstrap_routes(self):
        for path in ['/', '/dev/edition', '/dev/source-queue', '/internal/bootstrap', '/internal/login', '/internal/operations/../fixtures/security-fiction.ts']:
            with self.subTest(path=path):
                response = self.context.request.get(self.origin + path)
                self.assertIn(response.status, [400, 404])
                self.assertNotIn('credential', response.text().lower())
        response = self.context.request.get(self.origin + '/internal/operations')
        self.assertEqual(response.status, 200)
        self.assertIn('no-store', response.headers['cache-control'])
        self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
        self.assertIn("connect-src 'self'", response.headers['content-security-policy'])

    def test_keyboard_navigation_focus_and_consequential_action_cancellation(self):
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator('.skip').evaluate('element => document.activeElement === element'))
        self.page.keyboard.press('Enter')
        self.connect('managing')
        self.page.locator('nav a[href="#sources"]').focus()
        self.page.keyboard.press('Enter')
        self.assertTrue(self.page.locator('#sources-heading').is_visible())
        self.inspect('pending')
        self.page.select_option('#review-reason', 'INITIAL_REVIEW')
        self.page.locator('#review-evidence input[value="' + self.ids['proof'] + '"]').check()
        self.page.locator('#review-begin').focus()
        self.page.keyboard.press('Tab')
        self.page.keyboard.press('Shift+Tab')
        self.assertGreater(self.page.locator(':focus-visible').count(), 0)
        self.confirm_click(self.page.locator('#review-begin'), accept=False)
        self.assertIn('UNREVIEWED', self.page.locator('#detail-state').inner_text())
        self.assertTrue(self.page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'))

    def test_responsive_and_200_percent_css_enlargement_reflow(self):
        self.connect()
        for width in [1440, 768, 390, 320]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 1000})
                self.assert_reflow()
                if width in [1440, 390]:
                    self.assertFalse(bool(self.page.locator('#development-credential').input_value()), 'Credential input must be cleared before screenshots')
                    self.page.screenshot(path=f'/tmp/dayline-007e-operations-{width}.png', full_page=True)
        self.page.set_viewport_size({'width': 720, 'height': 1000})
        self.assert_reflow()
        self.page.set_viewport_size({'width': 1440, 'height': 1000})
        self.page.evaluate('document.documentElement.style.zoom = "2"')
        self.assertEqual(float(self.page.evaluate('getComputedStyle(document.documentElement).zoom')), 2)
        self.assert_reflow()

    def test_loading_unavailable_and_safe_error_states(self):
        self.connect()
        pending = []
        self.page.route('**/internal/operations/sources', lambda route: self.hold_route(route, pending))
        self.page.locator('#refresh-all').click()
        self.page.wait_for_function('() => document.querySelector("#global-status").dataset.state === "loading"')
        self.wait_held(pending)
        pending[0].fulfill(status=503, json={'error': 'PRIVATE_UPSTREAM_DETAIL'})
        self.page.wait_for_function('() => document.querySelector("#source-list").dataset.state === "unavailable"')
        self.assertNotIn('PRIVATE_UPSTREAM_DETAIL', self.page.inner_text('body'))
        self.assertEqual(self.page.locator('#source-list [data-source-id]').count(), 0)
        self.page.unroute('**/internal/operations/sources')
        self.refresh()
        self.assertGreater(self.page.locator('#source-list [data-source-id]').count(), 0)

    def test_assignment_loss_removes_records_and_selection(self):
        self.connect()
        self.command('clearAssignments', role='editor')
        self.page.wait_for_function('() => document.querySelector("#source-list").dataset.state === "denied"', timeout=5000)
        self.page.wait_for_function('() => document.querySelectorAll("#story-list [data-story-id], #edition-list [data-edition-id]").length === 0', timeout=5000)
        self.assertEqual(self.page.locator('#source-list [data-source-id]').count(), 0)
        self.assertEqual(self.page.locator('#story-list [data-story-id]').count(), 0)
        self.assertEqual(self.page.locator('#edition-list [data-edition-id]').count(), 0)
        self.assertTrue(self.page.locator('#prepare-story').is_disabled())

    def test_pagehide_clears_protected_records_without_automatic_reconnect(self):
        self.connect()
        self.page.evaluate('window.dispatchEvent(new PageTransitionEvent("pagehide"))')
        self.assertFalse(self.page.locator('#workspace').is_visible())
        self.assertEqual(self.page.locator('#source-list [data-source-id]').count(), 0)
        self.assertTrue(self.page.locator('#disconnect').is_disabled())

    def test_late_response_after_disconnect_cannot_restore_protected_data(self):
        self.connect()
        delayed = []
        self.page.route('**/internal/operations/sources', lambda route: self.hold_route(route, delayed))
        self.page.locator('#refresh-all').click()
        self.page.wait_for_function('() => document.querySelector("#global-status").dataset.state === "loading"')
        self.wait_held(delayed)
        status, authorized = self.api('/internal/operations/sources', {})
        self.assertEqual(status, 200)
        self.page.locator('#disconnect').click()
        for route in delayed:
            route.fulfill(status=200, json=authorized)
        self.page.wait_for_load_state('networkidle')
        self.assertFalse(self.page.locator('#workspace').is_visible())
        self.assertEqual(self.page.locator('#source-list [data-source-id]').count(), 0)
        self.assertNotIn('Fictional workflow proof report', self.page.inner_text('body'))

    def test_missing_trusted_bridge_never_creates_a_synthetic_session(self):
        context = self.browser.new_context()
        try:
            context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(self.origin + '/') else route.abort())
            page = context.new_page()
            page.goto(self.origin + '/internal/operations', wait_until='domcontentloaded')
            self.assertFalse(page.locator('#fixture-connection').is_visible())
            self.assertTrue(page.locator('#manual-connection').is_visible())
            page.locator('#connect').click()
            self.assertFalse(page.locator('#workspace').is_visible())
            self.assertEqual(page.locator('#source-list [data-source-id]').count(), 0)
            self.assertIn('credential', page.locator('#connection-state').inner_text().lower())
        finally:
            context.close()

    def test_delayed_old_source_detail_cannot_return_after_filter_and_new_inspection(self):
        # Freeze elapsed browser time so this request-order test does not become
        # a competing lease-expiry test on a busy shared CI worker.
        self.page.clock.install(time='2026-06-01T12:00:00.000Z')
        self.page.clock.pause_at('2026-06-01T12:00:01.000Z')
        self.connect()
        self.inspect('pending')
        status, old_detail = self.api('/internal/operations/source', {'sourceId': self.ids['pending']})
        self.assertEqual(status, 200)
        delayed = []

        def delay_old_detail(route):
            if route.request.post_data_json['sourceId'] == self.ids['pending']:
                self.hold_route(route, delayed)
            else:
                route.continue_()

        self.page.route('**/internal/operations/source', delay_old_detail)
        # Explicit refresh exercises the same refresh path as polling, while
        # waiting for the intercepted request rather than a timer estimate.
        self.page.locator('#refresh-all').click()
        self.wait_held(delayed)
        self.page.locator('#source-filter button').click()
        self.inspect('proof')
        self.assertIn(self.ids['proof'], self.page.locator('#detail-content').inner_text())
        for route in delayed:
            route.fulfill(status=200, json=old_detail)
        self.page.wait_for_load_state('networkidle')
        self.assertIn(self.ids['proof'], self.page.locator('#detail-content').inner_text())
        self.assertNotIn(self.ids['pending'], self.page.locator('#detail-content').inner_text())

    def test_delayed_old_selection_cannot_replace_new_source_token_or_clear_it(self):
        self.command('resolve', source='pending')
        self.connect()
        status, old_selection = self.api('/internal/source-handoff/inspect', {'sourceIds': [self.ids['pending']]})
        self.assertEqual(status, 200)
        delayed = []

        def delay_first_selection(route):
            if not delayed:
                self.hold_route(route, delayed)
            else:
                route.continue_()

        self.page.route('**/internal/source-handoff/inspect', delay_first_selection)
        self.page.locator('#select-' + self.ids['pending']).check()
        self.page.locator('#validate-sources').click()
        self.wait_held(delayed)
        self.assertEqual(len(delayed), 1)
        self.page.locator('#clear-selection').click()
        self.page.locator('#select-' + self.ids['alternate']).check()
        self.page.locator('#validate-sources').click()
        self.page.wait_for_function('() => !document.querySelector("#prepare-story").disabled')
        delayed[0].fulfill(status=409, json={'error': 'CONFLICT'})
        self.page.wait_for_load_state('networkidle')
        self.assertTrue(self.page.locator('#prepare-story').is_enabled())
        self.assertIn(self.ids['alternate'], self.page.locator('#selected-sources').inner_text())
        self.assertNotIn(self.ids['pending'], self.page.locator('#selected-sources').inner_text())
        self.fill_story('alternate')
        self.page.locator('#evidence-verified').check()
        with self.page.expect_response(lambda response: response.url == self.origin + '/internal/source-handoff/prepare') as result:
            self.confirm_click(self.page.locator('#prepare-story'))
        self.assertEqual(result.value.status, 200)

    def test_slow_mutation_clears_leased_records_and_preserves_human_draft(self):
        self.select_pending()
        fields = self.fill_story()
        self.page.locator('#evidence-verified').check()
        delayed = []
        self.page.route('**/internal/source-handoff/prepare', lambda route: self.hold_route(route, delayed))
        self.confirm_click(self.page.locator('#prepare-story'))
        self.wait_held(delayed)
        self.assertEqual(len(delayed), 1)
        self.page.wait_for_timeout(1700)
        for container, attribute in [('source-list', 'source-id'), ('story-list', 'story-id'), ('edition-list', 'edition-id')]:
            self.assertEqual(self.page.locator('#' + container + ' [data-' + attribute + ']').count(), 0)
        self.assertEqual(self.page.locator('#story-headline').input_value(), fields['story-headline'])
        self.assertEqual(self.page.locator('#story-summary').input_value(), fields['story-summary'])
        delayed[0].fulfill(status=503, json={'error': 'UNAVAILABLE'})
        self.page.wait_for_function('() => document.querySelector("#source-list").dataset.state === "ready"')
        self.assertEqual(self.page.locator('#story-headline').input_value(), fields['story-headline'])
        self.assertEqual(self.page.locator('[data-story-id="' + self.bootstrap['storyId'] + '"]').count(), 0)

    def test_late_success_for_old_source_subset_cannot_validate_current_selection(self):
        self.command('resolve', source='pending')
        self.connect()
        status, old_selection = self.api('/internal/source-handoff/inspect', {'sourceIds': [self.ids['pending']]})
        self.assertEqual(status, 200)
        delayed = []
        self.page.route('**/internal/source-handoff/inspect', lambda route: self.hold_route(route, delayed))
        self.page.locator('#select-' + self.ids['pending']).check()
        self.page.locator('#validate-sources').click()
        self.wait_held(delayed)
        self.assertEqual(len(delayed), 1)
        self.page.locator('#select-' + self.ids['alternate']).check()
        delayed[0].fulfill(status=200, json=old_selection)
        self.page.wait_for_load_state('networkidle')
        self.assertTrue(self.page.locator('#prepare-story').is_disabled())
        self.assertIn('2 explicitly selected', self.page.locator('#selected-state').inner_text())

    def test_targeted_axe_loaded_denied_and_human_form_states(self):
        self.assertTrue(AXE_PATH.is_file(), 'The local axe bundle is required')
        axe_source = AXE_PATH.read_text(encoding='utf-8')
        self.select_pending()
        self.fill_story()
        for role in ['editor', 'admin']:
            with self.subTest(role=role):
                if role != 'editor':
                    self.connect(role)
                self.page.evaluate(axe_source)
                violations = self.page.evaluate('''async () => (await axe.run(document, {
                    runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}
                })).violations.map(row => ({id:row.id,impact:row.impact,targets:row.nodes.map(node => node.target)}))''')
                self.assertEqual(violations, [], json.dumps(violations))


if __name__ == '__main__':
    unittest.main()
