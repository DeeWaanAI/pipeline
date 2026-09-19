-- 020: widen llm_providers.api_key_ref from VARCHAR(255) to TEXT.
-- Encrypted keys are stored as salt:iv:authTag:ciphertext = 131 chars of overhead
-- + 2x the raw key length in hex. Modern provider keys (OpenAI sk-proj ~164 chars,
-- Anthropic ~108, Aliyun DashScope ~114) encrypt to 347-459 chars and overflowed
-- the column, so createProvider failed with "Data too long for column 'api_key_ref'"
-- while fetchModelsPreview (raw key, no encryption) kept working.
ALTER TABLE llm_providers MODIFY COLUMN api_key_ref TEXT NOT NULL;
