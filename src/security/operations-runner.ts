/** Fictional local browser harness; credentials travel only through an anonymous child pipe. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFictionalOperationsEnvironment, seedEditorialOperationsFixture } from '../../fixtures/editorial-operations-fiction.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { SecurityError } from './verifier.ts';

async function demonstration() {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-operations-demo-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const c = await seedEditorialOperationsFixture(repository);
    const id = c.sourceIds.pending, evidenceReferences = [c.sourceIds.proof];
    const inspected = await c.sourceReview.inspect(c.accounts.editor.credential, id);
    const begun = await c.sourceReview.begin(c.accounts.managing.credential, id,
      { revision: inspected.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences });
    const proposed = await c.sourceReview.propose(c.accounts.managing.credential, id,
      { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences, classification: 'SECONDARY', originId: null });
    let selfConfirmationDenied = false, recommendationCannotPrepare = false;
    try { await c.sourceHandoff.inspect(c.accounts.editor.credential, [id]); } catch (error) {
      if (!(error instanceof SecurityError)) throw error; recommendationCannotPrepare = true;
    }
    try { await c.sourceReview.confirm(c.accounts.managing.credential, id,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences }); } catch (error) {
      if (!(error instanceof SecurityError) || error.code !== 'PERMISSION_DENIED') throw error; selfConfirmationDenied = true;
    }
    const confirmed = await c.sourceReview.confirm(c.accounts.confirming.credential, id,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences });
    const sources = await c.sourceHandoff.inspect(c.accounts.editor.credential, [id]);
    const prepared = await c.sourceHandoff.prepare(c.accounts.editor.credential, { sources, story: c.humanStory });
    let version = prepared.version;
    for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) {
      version = (await c.editorial.reviewStory(c.accounts.editor.credential, c.humanStory.id, version, status)).version;
    }
    const approved = await c.editorial.approveStory(c.accounts.managing.credential, c.humanStory.id, version);
    const edition = await c.editorial.assembleEdition(c.accounts.editor.credential, { date: '2026-06-01', timezone: 'UTC',
      placements: [{ storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES', featured: true }] });
    if (!selfConfirmationDenied || !recommendationCannotPrepare || prepared.status !== 'INGESTED' || edition.status !== 'ASSEMBLING') throw Error();
    process.stdout.write(JSON.stringify({ fictional: true, developmentOnly: true, asOf: c.clock.now(),
      pending: inspected.status, recommendation: proposed.status, recommendationCannotPrepare,
      selfConfirmationDenied, independentConfirmation: confirmed.status, preparedStory: prepared.status,
      separateExplicitApproval: approved.status, edition: edition.status, publicPublication: false,
      productionIdentity: false, providerCalls: 0 }) + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function browser() {
  let environment: Awaited<ReturnType<typeof createFictionalOperationsEnvironment>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let completion: Promise<number | null> | undefined;
  let stop: (() => void) | undefined;
  let stopping = false;
  const interrupted = new Promise<void>(resolve => { stop = resolve; });
  const onSignal = () => { stopping = true; child?.kill(); stop?.(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    environment = await createFictionalOperationsEnvironment();
    if (stopping) return;
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    child = spawn(python, [fileURLToPath(new URL('../../scripts/operations-browser.py', import.meta.url)), '--fictional-private-pipe'],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: false,
        // Browser profiles/artifacts also belong to this disposable harness, including launch failures.
        env: { ...process.env, TMPDIR: environment.directory, TEMP: environment.directory, TMP: environment.directory } });
    completion = new Promise<number | null>((resolve, reject) => {
      child!.once('error', () => reject(Error('Fictional browser unavailable')));
      child!.once('exit', code => resolve(code));
    });
    child.stdin!.on('error', () => { /* Child errors are represented by its fixed safe completion failure. */ });
    child.stdin!.end(JSON.stringify(environment.bootstrap()) + '\n');
    process.stdout.write(`Fictional development operations: ${environment.origin}/internal/operations\nChoose a fictional role and Connect in the opened browser. Close the browser or press Ctrl+C to remove the temporary repository.\n`);
    const result = await Promise.race([completion, interrupted.then(() => 0)]);
    if (result !== 0) throw Error('Fictional browser unavailable');
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    child?.kill();
    if (completion) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([completion.catch(() => null), new Promise<null>(resolve => {
        timeout = setTimeout(() => { child?.kill('SIGKILL'); resolve(null); }, 5000);
      })]); } finally { clearTimeout(timeout); }
    }
    await environment?.close();
  }
}

async function main() {
  if (['staging', 'production'].includes(process.env.NODE_ENV ?? '')) throw Error('Fictional operations unavailable');
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--fictional') await browser();
  else if (args.length === 2 && args[0] === '--fictional' && args[1] === '--demo') await demonstration();
  else throw Error('Only the isolated fictional harness is supported');
}
main().catch(() => { process.stderr.write('Fictional editorial operations unavailable; Python Playwright and Chromium are required for browser mode\n'); process.exitCode = 1; });
