# x509-signature-inspector

Offline X.509 signature algorithm review. Flags SHA-1 risk in DER-encoded
certificate snapshots. No network, no dependencies at runtime.

## API

```ts
import { inspectCertificate, inspectChain } from "x509-signature-inspector";

inspectCertificate(der); // "SAFE" | "WEAK" | "UNKNOWN" | "INVALID"
inspectChain(certs);     // true only when every certificate is SAFE
```

`SAFE` only means the snapshot passed this algorithm review; it does **not**
mean the certificate is trustworthy.

## Rules

- Reads `Certificate.signatureAlgorithm` and `TBSCertificate.signature`
  (with or without the optional version field). OIDs inside public keys and
  extensions never affect the verdict. Inner/outer mismatch is `INVALID`.
- Supported: RSA with SHA-1/SHA-256/SHA-384/SHA-512 and RSASSA-PSS.
  For supported RSA and hash AlgorithmIdentifiers, NULL and absent
  parameters are equivalent. Unknown OIDs and unsupported parameters keep
  their raw encoding for the inner/outer comparison.
- PSS parameters must be a SEQUENCE; explicit tags 0-3 are
  hashAlgorithm, maskGenAlgorithm, saltLength, trailerField, defaulting to
  SHA-1, MGF1(SHA-1), 20, 1. Explicit defaults are allowed and filled in
  for comparison. Only MGF1 and the four hashes are recognized;
  trailerField must be 1.
- Verdicts: structurally valid but unsupported algorithm/parameters →
  `UNKNOWN`; fully recognized and consistent → `WEAK` when the main hash or
  the MGF1 hash is SHA-1, otherwise `SAFE`.

## Develop

```sh
npm install
npm test   # builds with tsc, runs node:test suites
```

Test fixtures are built locally as DER bytes in `test/fixtures.ts`.
