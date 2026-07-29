'use client';

/**
 * Fetch one domain route into the four states a screen has to distinguish.
 *
 * Every domain screen was hand-rolling this, and the hand-rolled copies drifted
 * in exactly the way that matters: some collapsed not-yet-asked into empty, some
 * reported an aborted request as an error, and each worded its failure
 * differently. Those are not cosmetic differences — nothing-matched,
 * request-failed and not-yet-loaded are three different facts about the world,
 * and a reader who cannot tell them apart has lost the only information they
 * needed.
 *
 * Passing `null` as the path means *nothing has been asked for yet*, which is
 * why `idle` exists as a state of its own rather than as an empty result.
 */

import { useEffect, useState } from 'react';

export type Load<T> =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ok'; data: T };

export function useRouteData<T>(path: string | null): Load<T> {
	const [load, setLoad] = useState<Load<T>>(
		path === null ? { status: 'idle' } : { status: 'loading' },
	);

	useEffect(() => {
		if (path === null) {
			setLoad({ status: 'idle' });
			return;
		}
		const ac = new AbortController();
		setLoad({ status: 'loading' });
		fetch(path, { signal: ac.signal })
			.then(async (res) => {
				if (!res.ok) {
					// The status is the finding. A route that answered 502 has said
					// something specific, and flattening it to "failed to load" throws
					// away the part a reader can act on.
					throw new Error(`The route returned HTTP ${res.status}.`);
				}
				return (await res.json()) as T;
			})
			.then((data) => setLoad({ status: 'ok', data }))
			.catch((err: unknown) => {
				// An abort is this component moving on, not a failure of the route.
				if (ac.signal.aborted) return;
				setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) });
			});
		return () => ac.abort();
	}, [path]);

	return load;
}
