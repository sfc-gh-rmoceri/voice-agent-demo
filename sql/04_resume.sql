-- Bring the TTS service back up.
--
-- This returns as soon as the resume is accepted, not when the service is
-- ready. A cold start takes several minutes: node provisioning, then image
-- pull, then Kokoro model load. Poll until ready with:
--
--   snow sql -c <conn> -q "DESCRIBE SERVICE VOICE_DEMO.TTS.KOKORO_TTS"
--
-- or use the app's Warm Up control, which polls for you.

USE ROLE VOICE_TTS_ROLE;

ALTER COMPUTE POOL VOICE_TTS_POOL RESUME;

SHOW COMPUTE POOLS LIKE 'VOICE_TTS_POOL';
