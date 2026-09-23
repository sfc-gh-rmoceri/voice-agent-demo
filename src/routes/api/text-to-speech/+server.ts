import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfig } from '$lib/config';
import { getIngressUrl, getTtsState } from '$lib/snowflake';

/**
 * Stream synthesized speech from the self-hosted Kokoro service running in
 * Snowpark Container Services.
 *
 * Exposed over GET as well as POST specifically so the client can point an
 * <audio> element straight at this URL: the browser then does native
 * progressive playback and starts as soon as the first bytes arrive, instead
 * of buffering the whole clip first. Over POST the caller has to read the
 * body itself, which loses that.
 *
 * On any failure this returns 503 with { fallback: true } so the client can
 * drop back to the browser's built-in speech synthesis.
 */
async function synthesize(text: string): Promise<Response> {
	if (!text || !text.trim()) {
		return json({ error: 'No text provided' }, { status: 400 });
	}

	const { state, detail } = await getTtsState();
	if (state !== 'READY') {
		return json({ fallback: true, state, detail }, { status: 503 });
	}

	const ingress = await getIngressUrl();
	if (!ingress) {
		return json({ fallback: true, state: 'STARTING', detail: 'No endpoint' }, { status: 503 });
	}

	const { token } = getConfig().snowflake;

	try {
		const upstream = await fetch(`${ingress}/v1/audio/speech`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Snowflake Token="${token}"`
			},
			body: JSON.stringify({
				model: 'kokoro',
				voice: 'af_heart',
				input: text.slice(0, 3000),
				response_format: 'mp3',
				stream: true
			})
		});

		if (!upstream.ok || !upstream.body) {
			return json(
				{ fallback: true, state: 'UNAVAILABLE', detail: `Kokoro returned ${upstream.status}` },
				{ status: 503 }
			);
		}

		// Pass the body straight through. No Content-Length, so the browser
		// treats it as a stream and begins playback on the first chunk.
		return new Response(upstream.body, {
			headers: {
				'Content-Type': 'audio/mpeg',
				'Cache-Control': 'no-cache',
				// Vite's dev middleware will otherwise buffer the whole body
				// before flushing, which defeats progressive playback.
				'X-Accel-Buffering': 'no'
			}
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : 'Request failed';
		return json({ fallback: true, state: 'UNAVAILABLE', detail }, { status: 503 });
	}
}

/** Used by <audio src="..."> for progressive playback. */
export const GET: RequestHandler = async ({ url }) => {
	return synthesize(url.searchParams.get('text') ?? '');
};

export const POST: RequestHandler = async ({ request }) => {
	const { text } = await request.json();
	return synthesize(text);
};
