import { getConfig } from './config';

interface SqlApiResponse {
	data?: string[][];
	resultSetMetaData?: { rowType: Array<{ name: string }> };
	message?: string;
}

/**
 * Run a statement through the Snowflake SQL API and return rows as objects
 * keyed by column name. The SQL API returns positional arrays plus separate
 * column metadata, so we zip them here.
 */
export async function querySnowflake(
	statement: string,
	role?: string
): Promise<Record<string, string>[]> {
	const { account, token } = getConfig().snowflake;

	const response = await fetch(`https://${account}.snowflakecomputing.com/api/v2/statements`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({
			statement,
			timeout: 60,
			...(role ? { role } : {})
		})
	});

	if (!response.ok) {
		throw new Error(`SQL API ${response.status}: ${await response.text()}`);
	}

	const result: SqlApiResponse = await response.json();
	const columns = result.resultSetMetaData?.rowType?.map((c) => c.name) ?? [];
	const rows = result.data ?? [];

	return rows.map((row) => {
		const obj: Record<string, string> = {};
		columns.forEach((col, i) => {
			obj[col] = row[i];
		});
		return obj;
	});
}

const SERVICE = 'VOICE_DEMO.TTS.KOKORO_TTS';
const POOL = 'VOICE_TTS_POOL';

/**
 * The PAT is role-restricted, so we cannot request a different role on the
 * SQL API call. VOICE_TTS_ROLE is granted to SYSADMIN instead, letting the
 * PAT's role inherit the compute pool and service privileges.
 */
const ROLE = undefined;

export type TtsState = 'READY' | 'STARTING' | 'SUSPENDED' | 'UNAVAILABLE';

let cachedIngressUrl: string | null = null;

/**
 * Resolve the service's public ingress hostname. Cached because it is stable
 * for the life of the service.
 */
export async function getIngressUrl(): Promise<string | null> {
	if (cachedIngressUrl) return cachedIngressUrl;

	try {
		const rows = await querySnowflake(`SHOW ENDPOINTS IN SERVICE ${SERVICE}`, ROLE);
		const endpoint = rows.find((r) => r.name === 'api');
		const host = endpoint?.ingress_url;
		if (host && !host.includes('Endpoints provisioning in progress')) {
			cachedIngressUrl = `https://${host}`;
			return cachedIngressUrl;
		}
	} catch {
		// service may not exist yet
	}
	return null;
}

/**
 * Report whether the TTS service can serve a request right now.
 *
 * A suspended pool takes several minutes to come back (node provisioning,
 * image pull, model load), so callers should treat anything other than READY
 * as "fall back to browser speech" rather than something to wait on.
 */
export async function getTtsState(): Promise<{ state: TtsState; detail: string }> {
	let poolState = '';
	try {
		const pools = await querySnowflake(`SHOW COMPUTE POOLS LIKE '${POOL}'`, ROLE);
		poolState = pools[0]?.state ?? '';
	} catch {
		return { state: 'UNAVAILABLE', detail: 'Compute pool not found' };
	}

	if (!poolState) return { state: 'UNAVAILABLE', detail: 'Compute pool not found' };

	if (poolState === 'SUSPENDED' || poolState === 'STOPPING') {
		return { state: 'SUSPENDED', detail: `Pool ${poolState.toLowerCase()}` };
	}

	if (poolState === 'STARTING' || poolState === 'RESIZING') {
		return { state: 'STARTING', detail: 'Provisioning node' };
	}

	// Pool is ACTIVE or IDLE — now check the service itself.
	try {
		const svc = await querySnowflake(`DESCRIBE SERVICE ${SERVICE}`, ROLE);
		const status = svc[0]?.status ?? '';
		if (status === 'RUNNING') {
			const url = await getIngressUrl();
			return url
				? { state: 'READY', detail: 'Kokoro ready' }
				: { state: 'STARTING', detail: 'Endpoint provisioning' };
		}
		// A suspended service on a live pool will not start on its own.
		if (status === 'SUSPENDED') {
			await ensureServiceResumed();
			return { state: 'STARTING', detail: 'Starting container' };
		}
		return { state: 'STARTING', detail: `Service ${status.toLowerCase() || 'starting'}` };
	} catch {
		return { state: 'UNAVAILABLE', detail: 'Service not created' };
	}
}

export async function resumeTts(): Promise<void> {
	// Resuming the pool does not resume its services — suspending a pool
	// suspends them, and they must be brought back explicitly.
	await querySnowflake(`ALTER COMPUTE POOL ${POOL} RESUME`, ROLE);
	try {
		await querySnowflake(`ALTER SERVICE ${SERVICE} RESUME`, ROLE);
	} catch {
		// The service cannot resume until the pool has a node; the status
		// poller will retry via ensureServiceResumed().
	}
}

/**
 * Called from the status poller: if the pool has capacity but the service is
 * still suspended, nudge it. Safe to call repeatedly.
 */
export async function ensureServiceResumed(): Promise<void> {
	try {
		await querySnowflake(`ALTER SERVICE ${SERVICE} RESUME`, ROLE);
	} catch {
		// already running, or pool not ready yet
	}
}

export async function suspendTts(): Promise<void> {
	await querySnowflake(`ALTER COMPUTE POOL ${POOL} SUSPEND`, ROLE);
	cachedIngressUrl = null;
}
