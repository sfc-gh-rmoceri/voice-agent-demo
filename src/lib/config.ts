import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface SnowflakeConfig {
	account: string;
	token: string;
	database: string;
	schema: string;
	agent: string;
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
				database: env.SNOWFLAKE_DATABASE || 'INTERACTIVE_DEMO',
				schema: env.SNOWFLAKE_SCHEMA || 'RETAIL',
				agent: env.SNOWFLAKE_AGENT || 'RETAIL_ANALYTICS_AGENT'
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
