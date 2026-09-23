import { querySnowflake } from '$lib/snowflake';

export interface AgentInfo {
	/** Fully qualified: DATABASE.SCHEMA.NAME */
	id: string;
	database: string;
	schema: string;
	name: string;
	/** Friendly name from the agent's profile, falling back to the object name. */
	displayName: string;
	/** The agent's own COMMENT, used as the app's subtitle and welcome blurb. */
	description: string;
}

/**
 * List the Cortex Agents this role can see.
 *
 * Agents carry their own presentation metadata — a `profile` JSON with
 * display_name/color and a COMMENT describing what they answer — so the UI can
 * brand itself from whichever agent the user picks instead of requiring
 * per-deployment configuration.
 */
export async function listAgents(): Promise<AgentInfo[]> {
	const rows = await querySnowflake('SHOW AGENTS IN ACCOUNT');

	return rows
		.map((row) => {
			const database = row.database_name ?? '';
			const schema = row.schema_name ?? '';
			const name = row.name ?? '';

			// profile is a JSON string and is frequently empty or absent.
			let displayName = name;
			if (row.profile) {
				try {
					const profile = JSON.parse(row.profile);
					if (profile.display_name) displayName = profile.display_name;
				} catch {
					/* malformed profile is not worth failing the list over */
				}
			}

			return {
				id: `${database}.${schema}.${name}`,
				database,
				schema,
				name,
				displayName,
				description: row.comment ?? ''
			};
		})
		.filter((a) => a.database && a.schema && a.name)
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
