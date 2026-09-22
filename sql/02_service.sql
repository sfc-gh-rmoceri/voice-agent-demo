-- Create the Kokoro TTS service.
-- Owned by VOICE_TTS_ROLE because ACCOUNTADMIN cannot own a service.
-- Requires 01_setup.sql to have run and the image to be pushed
-- (see scripts/push-image.sh).

USE ROLE VOICE_TTS_ROLE;

CREATE SERVICE IF NOT EXISTS VOICE_DEMO.TTS.KOKORO_TTS
  IN COMPUTE POOL VOICE_TTS_POOL
  MIN_INSTANCES = 1
  MAX_INSTANCES = 1
  COMMENT = 'Kokoro-82M text-to-speech service exposing an OpenAI-compatible speech endpoint on port 8880'
  FROM SPECIFICATION $$
spec:
  containers:
    - name: kokoro
      image: /VOICE_DEMO/TTS/IMAGES/kokoro-tts:latest
      env:
        PORT: "8880"
      resources:
        requests:
          cpu: "4"
          memory: "8Gi"
        limits:
          cpu: "6"
          memory: "24Gi"
      readinessProbe:
        port: 8880
        path: /health
  endpoints:
    - name: api
      port: 8880
      protocol: HTTP
      public: true
$$;

-- The service is only usable once status is RUNNING and the readiness probe
-- passes. Expect several minutes on a cold pool: node provisioning, then
-- image pull, then model load.
DESCRIBE SERVICE VOICE_DEMO.TTS.KOKORO_TTS;
SHOW ENDPOINTS IN SERVICE VOICE_DEMO.TTS.KOKORO_TTS;
