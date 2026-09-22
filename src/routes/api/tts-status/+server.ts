import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTtsState, resumeTts, suspendTts } from '$lib/snowflake';

/** Report whether the Kokoro service can serve requests right now. */
export const GET: RequestHandler = async () => {
	const { state, detail } = await getTtsState();
	return json({ state, detail, engine: state === 'READY' ? 'kokoro' : 'browser' });
};

/**
 * Resume or suspend the TTS compute pool.
 * Returns as soon as the request is accepted — resuming takes several minutes,
 * so the client polls GET until the state flips to READY.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { action } = await request.json();

	try {
		if (action === 'resume') {
			await resumeTts();
		} else if (action === 'suspend') {
			await suspendTts();
		} else {
			return json({ error: 'action must be "resume" or "suspend"' }, { status: 400 });
		}
	} catch (err) {
		const detail = err instanceof Error ? err.message : 'Request failed';
		return json({ error: detail }, { status: 500 });
	}

	const { state, detail } = await getTtsState();
	return json({ state, detail, engine: state === 'READY' ? 'kokoro' : 'browser' });
};
