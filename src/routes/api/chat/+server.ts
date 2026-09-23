import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfig } from '$lib/config';

export const POST: RequestHandler = async ({ request }) => {
	const config = getConfig();
	const { account, token } = config.snowflake;
	const body = await request.json();

	// The client may target any agent the role can see, so a single deployment
	// can be pointed at different agents without redeploying. Fall back to the
	// configured default when the client doesn't specify one.
	const database = body.agent?.database || config.snowflake.database;
	const schema = body.agent?.schema || config.snowflake.schema;
	const agent = body.agent?.name || config.snowflake.agent;

	if (!database || !schema || !agent) {
		return json(
			{ error: 'No agent selected and no default configured' },
			{ status: 400 }
		);
	}

	const messages = [
		...body.history.map((msg: { role: string; content: string }) => ({
			role: msg.role,
			content: [{ type: 'text', text: msg.content }]
		})),
		{ role: 'user', content: [{ type: 'text', text: body.message }] }
	];

	const agentUrl = `https://${account}.snowflakecomputing.com/api/v2/databases/${database}/schemas/${schema}/agents/${agent}:run`;

	const response = await fetch(agentUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({ messages })
	});

	if (!response.ok) {
		const details = await response.text();
		return json({ error: 'Agent request failed', details }, { status: response.status });
	}

	const reader = response.body!.getReader();
	const readable = new ReadableStream({
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

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
