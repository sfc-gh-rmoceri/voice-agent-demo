-- Shut the TTS service down. Suspending the compute pool releases its nodes
-- and stops all compute billing — pools are only charged in ACTIVE, IDLE,
-- STOPPING and RESIZING states, not SUSPENDED.
--
-- The service definition survives; resuming brings it back without a rebuild.

USE ROLE VOICE_TTS_ROLE;

ALTER COMPUTE POOL VOICE_TTS_POOL SUSPEND;

SHOW COMPUTE POOLS LIKE 'VOICE_TTS_POOL';
