-- Bring the TTS service back up.
--
-- Two steps are needed. Suspending a compute pool also suspends its services,
-- and resuming the pool does NOT bring them back — the service must be
-- resumed explicitly once the pool has a node.
--
-- Cold start takes several minutes overall: node provisioning, then a ~5GB
-- image pull, then Kokoro model load. Poll with `npm run tts:status`, or use
-- the app's Warm up button which polls for you.

USE ROLE VOICE_TTS_ROLE;

ALTER COMPUTE POOL VOICE_TTS_POOL RESUME;

-- Wait for the pool to report ACTIVE or IDLE before this succeeds. If it
-- errors with the pool still starting, re-run just this statement.
ALTER SERVICE VOICE_DEMO.TTS.KOKORO_TTS RESUME;

SHOW COMPUTE POOLS LIKE 'VOICE_TTS_POOL';
DESCRIBE SERVICE VOICE_DEMO.TTS.KOKORO_TTS;
