# Example pipelines

Seven pipelines with their evaluation records: pipeline, rubric, judging prompts, judgments and scores. Each folder is self-contained; `pipeline.json` imports into a local DeeWaanAI install.

| Example | Steps | Judges | Cases | Outputs |
|---|---|---|---|---|
| [Ice Cream Recipe Studio](ice-cream-recipe-studio/) | 4 | 3 | 1 | 2 |
| [CV Multi-Language Pack](cv-multi-language-pack/) | 3 | 3 | 1 | 2 |
| [Theme Travel Planner](theme-travel-planner/) | 4 | 3 | 1 | 2 |
| [Newsletter Voice Shaper](newsletter-voice-shaper/) | 3 | 3 | 1 | 2 |
| [Paper Digest](paper-digest/) | 3 | 3 | 1 | 2 |
| [Commit-to-Changelog](commit-to-changelog/) | 3 | 3 | 1 | 2 |
| [PR Review Companion](pr-review-companion/) | 4 | 3 | 1 | 2 |

## Verify these records

```bash
node examples/verify-examples.mjs
```

That recomputes each manifest's hash from the bytes in the file, checks the
Ed25519 signature carried inside it, and confirms the signed identity matches the
manifest. It needs **nothing else** — the attestation carries its own public key
and signed payload. All seven verify, under key `deewaanai-platform-2026-1`,
fingerprint:

```
27b3:1f5d:361b:1a82:7c0d:1a32:2c21:891e
```

To check that the key is *ours* rather than merely self-consistent (`--pin`):

```bash
node examples/verify-examples.mjs --pin platform-public-key.pem
```

## Two honest limits

- **Test inputs are synthetic.** Names, addresses and documents in the examples
  are fabricated for demonstration. The signed bytes are kept intact, so the
  signature stays verifiable; don't read them as real customer data.
- **`pipeline.json` will not hash to `definitionHash`.** The certified definition
  recorded which provider row each step used; the example strips those internal
  ids so it is safe to share and import. So `definitionHash` identifies the
  version these scores belong to, not a hash you can reproduce from the sanitised
  file. The manifest hash — what the signature covers — you *can* reproduce.
