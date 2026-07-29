'use client';

/**
 * URL-based state hooks for dashboard pages.
 *
 * Uses `nuqs` to sync component state with URL search params.
 * Gives back button, deep linking, and shareable URLs for free.
 *
 * Usage:
 *   const [view, setView] = useView();        // ?view=list
 *   const [id, setId] = useSelectedId();       // ?id=12345
 *   const [q, setQ] = useSearchQuery();        // ?q=search+term
 *
 * Navigate to detail:
 *   setView('detail'); setId(item.id);
 *
 * Back to list:
 *   setView('list'); setId(null);
 */

import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';

const VIEW_OPTIONS = ['list', 'detail', 'search'] as const;

/** The views `useView` can hold. Exported so a page can type its own switch. */
export type View = (typeof VIEW_OPTIONS)[number];

/** Current view — defaults to 'list'. Maps to ?view= URL param. */
export function useView() {
	return useQueryState('view', parseAsStringLiteral(VIEW_OPTIONS).withDefault('list'));
}

/** Selected item ID for detail views. Maps to ?id= URL param. */
export function useSelectedId() {
	return useQueryState('id', parseAsString.withDefault(''));
}

/** Search query string. Maps to ?q= URL param. */
export function useSearchQuery() {
	return useQueryState('q', parseAsString.withDefault(''));
}

/** Generic string param for custom use cases. */
export function useUrlParam(key: string, defaultValue = '') {
	return useQueryState(key, parseAsString.withDefault(defaultValue));
}
