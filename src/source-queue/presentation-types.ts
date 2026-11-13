import type { SourceQueuePage, SourceQueueQuery } from './types.ts';

/** Historical fictional metadata only. This is never an authenticated repository interface. */
export interface SourceQueueDisplay extends SourceQueuePage {
  fictional: true;
  developmentOnly: true;
  publiclyPublished: false;
  asOf: string;
  validForMs: number;
}
export interface SourceQueueDisplaySource {
  read(query?: SourceQueueQuery): Promise<SourceQueueDisplay | null>;
  dispose(): Promise<void>;
}
