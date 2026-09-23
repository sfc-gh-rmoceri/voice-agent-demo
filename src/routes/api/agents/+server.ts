import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAgents } from '$lib/agents';
import { getConfig } from '$lib/config';

/**
 * List selectable agents, plus whichever one is configured as the default.
 *
 * Returning the configured default alongside the list lets the client preselect
 * it without needing to know the config shape.
 */
export const GET: RequestHandler = async () => {
	let configured: string | null = null;
	try {
		const { database, schema, agent } = getConfig().snowflake;
		if (database && schema && agent) configured = `${database}.${schema}.${agent}`;
	} catch {
		// Not configured yet — the picker is the whole point in that case.
	}

	try {
		const agents = await listAgents();
		return json({ agents, configured });
	} catch (err) {
		const detail = err instanceof Error ? err.message : 'Failed to list agents';
		return json({ agents: [], configured, error: detail }, { status: 500 });
	}
};
