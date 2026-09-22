import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { getConfig } from '$lib/config';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const apiKey = config.elevenlabs.api_key;

	if (!apiKey) {
		return json({ error: 'ElevenLabs API key not configured' }, { status: 500 });
	}

	const elevenlabs = new ElevenLabsClient({ apiKey });

	const formData = await request.formData();
	const audioFile = formData.get('audio') as File | null;
	if (!audioFile) {
		return json({ error: 'No audio file provided' }, { status: 400 });
	}

	try {
		const result = await elevenlabs.speechToText.convert({
			file: audioFile,
			modelId: 'scribe_v2',
			tagAudioEvents: true
		});

		return json({ text: result.text, words: result.words });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Transcription failed';
		return json({ error: message }, { status: 500 });
	}
};
