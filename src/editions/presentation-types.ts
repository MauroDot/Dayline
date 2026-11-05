import type { EditionStatus, SectionId } from './types.ts';
/** Allowlisted reader display only; no internal IDs, policy grants, reviewers or audit. */
export interface DisplaySource { publisher: string; url: string }
export interface DisplayPlacement { headline: string; summary: string; featured: boolean; sources: DisplaySource[]; uncertainties: string[]; counterevidence: { recorded: boolean; label: string; sources: DisplaySource[] } }
export interface EditionDisplay { fictional: true; developmentOnly: true; publiclyPublished: false; date: string; timezone: string; revision: number; status: EditionStatus; reviewLabel: string; validForMs: number; sections: { id: SectionId; label: string; placements: DisplayPlacement[] }[] }
export interface EditionDisplaySource { read(): Promise<EditionDisplay | null>; dispose(): Promise<void> }
