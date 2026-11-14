"""Headed fictional development browser. Bootstrap exists only in a private anonymous pipe and memory."""
import json
import os
import stat
import signal
import sys
from urllib.parse import urlsplit


def main():
    channel = os.fstat(0).st_mode
    if (sys.argv[1:] != ['--fictional-private-pipe'] or sys.stdin.isatty()
            or not (stat.S_ISFIFO(channel) or stat.S_ISSOCK(channel))):
        raise ValueError('private pipe required')
    line = sys.stdin.readline(32769)
    if not line.endswith('\n') or len(line) > 32768:
        raise ValueError('invalid bootstrap')
    bootstrap = json.loads(line)
    origin = bootstrap['origin']
    url = urlsplit(origin)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path or url.query or url.fragment or url.username or url.password:
        raise ValueError('invalid private origin')
    roles = ('editor', 'managing', 'confirming', 'reporter', 'admin')
    if bootstrap.get('fictional') is not True or bootstrap.get('developmentOnly') is not True:
        raise ValueError('fictional mode required')
    accounts = bootstrap['accounts']
    if set(accounts) != set(roles) or any(not isinstance(accounts[role]['credential'], str)
                                           or len(accounts[role]['credential']) > 4096 for role in roles):
        raise ValueError('invalid fictional accounts')
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser = None
        context = None
        try:
            browser = playwright.chromium.launch(headless=False, executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium')
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            context.route('**/*', lambda route: route.continue_()
                          if route.request.url.startswith(origin + '/') else route.abort())

            def credential(source, role):
                # Navigation outside the guarded listener cannot use this trusted development binding.
                frame = urlsplit(source['frame'].url)
                if (role not in roles or source['frame'] != source['page'].main_frame
                        or f'{frame.scheme}://{frame.netloc}' != origin
                        or frame.path != '/internal/operations' or frame.query
                        or frame.fragment not in ('', 'overview', 'sources', 'preparation', 'stories', 'editions', 'main')):
                    raise ValueError('development credential unavailable')
                return accounts[role]['credential']

            context.expose_binding('daylineDevelopmentCredential', credential)
            page = context.new_page()
            page.goto(origin + '/internal/operations', wait_until='domcontentloaded')
            while context.pages and browser.is_connected():
                try:
                    context.pages[0].wait_for_timeout(200)
                except Exception:
                    break
        finally:
            if context:
                try:
                    context.close()
                except Exception:
                    pass
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass


if __name__ == '__main__':
    def interrupted(*_):
        raise InterruptedError('fictional browser interrupted')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception:
        # Never render exception messages, launch payloads or the bootstrap dictionary.
        sys.stderr.write('Fictional operations browser unavailable\n')
        sys.exit(1)
