/** Local fictional edition assertions. These are not licensed news or authenticated review. */
import { seedEditorialFixture, editorialAt } from './editorial-fiction.ts';
import type { JsonRepository } from '../src/newsroom/store.ts';

export const editionAt = editorialAt;

export async function seedEditionFixture(repository: JsonRepository, at = editionAt) {
  const fixture = await seedEditorialFixture(repository, at);
  await fixture.newsroom.transition(fixture.story.id, 'NEEDS_REVIEW', 'fictional-edition-editor');
  const story = await fixture.newsroom.transition(fixture.story.id, 'APPROVED', 'fictional-edition-reviewer');
  return { ...fixture, story };
}
