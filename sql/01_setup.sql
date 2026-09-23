-- Kokoro TTS on Snowpark Container Services — one-time setup
-- Run as ACCOUNTADMIN: compute pool creation and BIND SERVICE ENDPOINT are
-- account-level privileges. The service itself is owned by VOICE_TTS_ROLE
-- because ACCOUNTADMIN cannot own a service.

USE ROLE ACCOUNTADMIN;

CREATE DATABASE IF NOT EXISTS VOICE_DEMO
  COMMENT = 'Voice agent demo — hosts the Kokoro text-to-speech container service';

CREATE SCHEMA IF NOT EXISTS VOICE_DEMO.TTS
  COMMENT = 'Kokoro text-to-speech service, container image repository and related objects';

CREATE IMAGE REPOSITORY IF NOT EXISTS VOICE_DEMO.TTS.IMAGES
  COMMENT = 'Container images for the Kokoro TTS service';

-- Dedicated owner role for the service.
CREATE ROLE IF NOT EXISTS VOICE_TTS_ROLE
  COMMENT = 'Owns and operates the Kokoro TTS Snowpark Container Services service';

-- CPU_X64_M = 6 vCPU / 28 GiB. Kokoro-82M is small enough for CPU inference,
-- and the FastAPI wrapper streams audio so first-byte latency stays low.
-- AUTO_SUSPEND_SECS stops billing after 15 minutes of inactivity; suspended
-- pools incur no compute charges at all.
CREATE COMPUTE POOL IF NOT EXISTS VOICE_TTS_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_M
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 900
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'Kokoro TTS inference pool. Auto-suspends after 15 minutes idle to avoid idle cost.';

GRANT USAGE, OPERATE, MONITOR ON COMPUTE POOL VOICE_TTS_POOL TO ROLE VOICE_TTS_ROLE;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO ROLE VOICE_TTS_ROLE;

GRANT USAGE ON DATABASE VOICE_DEMO TO ROLE VOICE_TTS_ROLE;
GRANT USAGE ON SCHEMA VOICE_DEMO.TTS TO ROLE VOICE_TTS_ROLE;
GRANT CREATE SERVICE ON SCHEMA VOICE_DEMO.TTS TO ROLE VOICE_TTS_ROLE;
GRANT READ, WRITE ON IMAGE REPOSITORY VOICE_DEMO.TTS.IMAGES TO ROLE VOICE_TTS_ROLE;

-- Grant to whoever is running this, rather than a hardcoded user.
SET setup_user = CURRENT_USER();
GRANT ROLE VOICE_TTS_ROLE TO USER IDENTIFIER($setup_user);

-- A role-restricted PAT cannot request a different role on the SQL API call, so
-- the app cannot simply "USE ROLE VOICE_TTS_ROLE". Granting this role to
-- SYSADMIN lets the PAT's own role inherit the compute pool and service
-- privileges. Without this the app reports "Compute pool not found" even though
-- the pool exists.
GRANT ROLE VOICE_TTS_ROLE TO ROLE SYSADMIN;

-- Confirm
SHOW COMPUTE POOLS LIKE 'VOICE_TTS_POOL';
SHOW IMAGE REPOSITORIES IN SCHEMA VOICE_DEMO.TTS;
