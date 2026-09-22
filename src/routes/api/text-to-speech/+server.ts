import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfig } from '$lib/config';
import { getIngressUrl, getTtsState } from '$lib/snowflake';

/**
 * Proxy text to the self-hosted Kokoro TTS service running in Snowpark
 * Container Services, streaming the audio straight back to the browser.
 *
 * If the service is cold, suspended, or errors for any reason, this returns
 * 503 with { fallback: true } so the client can drop back to the browser's
 * built-in speech synthesis instead of failing silently.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { text } = await request.json();

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

		// Pipe the audio through as it is generated so playback can start
		// before the whole clip is rendered.
		const reader = upstream.body.getReader();
		const stream = new ReadableStream({
			async pull(controller) {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			},
			cancel() {
				reader.cancel();
			}
		});

		return new Response(stream, {
			headers: {
				'Content-Type': 'audio/mpeg',
				'Cache-Control': 'no-cache'
			}
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : 'Request failed';
		return json({ fallback: true, state: 'UNAVAILABLE', detail }, { status: 503 });
	}
};
