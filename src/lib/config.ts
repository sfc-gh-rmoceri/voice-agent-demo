import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface SnowflakeConfig {
	account: string;
	token: string;
	/**
	 * Default agent. All three are optional: when unset the app lists the
	 * agents the role can see and lets the user pick one at runtime.
	 */
	database?: string;
	schema?: string;
	agent?: string;
}

interface ElevenLabsConfig {
	api_key: string;
}

interface AppConfig {
	snowflake: SnowflakeConfig;
	elevenlabs: ElevenLabsConfig;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
	if (cached) return cached;

	const env = process.env;
	if (env.SNOWFLAKE_ACCOUNT && env.SNOWFLAKE_TOKEN) {
		cached = {
			snowflake: {
				account: env.SNOWFLAKE_ACCOUNT,
				token: env.SNOWFLAKE_TOKEN,
				// No defaults: guessing another account's objects would just
				// produce a confusing 404 from the agent endpoint.
				database: env.SNOWFLAKE_DATABASE,
				schema: env.SNOWFLAKE_SCHEMA,
				agent: env.SNOWFLAKE_AGENT
			},
			elevenlabs: {
				api_key: env.ELEVENLABS_API_KEY || ''
			}
		};
		return cached;
	}

	const configPath = join(process.cwd(), 'config.json');
	if (!existsSync(configPath)) {
		throw new Error('config.json not found and environment variables not set');
	}
	cached = JSON.parse(readFileSync(configPath, 'utf-8'));
	return cached!;
}
