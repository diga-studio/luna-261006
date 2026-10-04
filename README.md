# saml2-authn-request-verifier

A TypeScript library for identity providers / identity gateways to verify
SAML 2.0 `AuthnRequest` login requests (HTTP-POST binding) carrying an XML
signature. The trusted application directory and RSA public keys are supplied
by the caller and live in memory only — nothing is persisted.

The verifier does not stop at "some signature is valid". It only accepts a
request when the single XML signature on the root `AuthnRequest` provably
protects exactly the content the gateway will act on (request ID, `Issuer`,
`Destination`, `AssertionConsumerServiceURL`). Trust comes solely from the
caller-supplied directory; `KeyInfo` is never a trust source.

## Install, build, test

```sh
npm install
npm test        # compiles TypeScript and runs the test suite
npm run build   # compile only (output in dist/)
```

Runtime dependencies: none (Node.js >= 18, `node:crypto` only).
Dev dependency: `typescript`.

## Usage

```ts
import { verifyAuthnRequest } from "saml2-authn-request-verifier";

const result = verifyAuthnRequest(xmlUtf8String, {
  destination: "https://idp.example.com/saml/sso", // this gateway's Destination
  applications: [
    {
      entityID: "https://app1.example.com/sp",
      publicKey: process.env.APP1_PUBLIC_KEY_PEM!,   // RSA public key (PEM/DER/KeyObject)
      assertionConsumerServiceURLs: ["https://app1.example.com/saml/acs"],
    },
    // ... up to ~200 applications
  ],
});

if (result.ok) {
  // Trusted fields, all taken from the single fully-signed root request:
  // result.id, result.issuer, result.assertionConsumerServiceURL
} else {
  // result.reason — reject the login; no partially trusted fields exist.
}
```

Input is the UTF-8 XML document after the upper layer has decoded the
HTTP-POST form field and Base64. Requests larger than 256 KiB are rejected
(configurable via `maxXmlBytes`).

## What is enforced

- Root is `AuthnRequest` in the SAML 2.0 protocol namespace, `Version="2.0"`,
  non-empty namespace-less `ID`, exactly one direct child `Issuer` in the
  SAML 2.0 assertion namespace.
- `Issuer` matches a trusted application, `Destination` matches this gateway,
  `AssertionConsumerServiceURL` is on that application's callback list
  (exact string comparison, no URL normalization).
- Exactly one `Signature` (XMLDSig namespace) in the whole document, and it
  must be a direct child of the root. `SignedInfo` has exactly one
  `Reference` whose `URI` literally equals `#` + root ID. All `ID`/`Id`/`id`
  attribute values in the document (any namespace) must be unique.
- Algorithms only: RSA-SHA256 signature, SHA-256 digest, exclusive C14N
  without comments. Reference transforms must be exactly
  `enveloped-signature` then exclusive C14N. `InclusiveNamespaces`
  `PrefixList` (including `#default`) is supported.
- The signature is verified with the trusted key of the application named by
  the direct child `Issuer` — never with anything from `KeyInfo`.
- `DOCTYPE` and entity declarations are rejected; no external resources are
  ever read. Malformed XML, ambiguous references, and unsupported signature
  structures produce a clean rejection, never a crash.

Out of scope: login/session handling, replay detection, SAML response
issuance.

## Layout

- `src/xml.ts` — strict, safe XML parser (no DOCTYPE/entities, namespace-aware)
- `src/c14n.ts` — exclusive XML canonicalization 1.0 without comments
- `src/verify.ts` — AuthnRequest structural + cryptographic verification
- `src/index.ts` — public API
- `test/` — test suite with real RSA keys/signatures generated at runtime
  (`test/helpers.ts` contains a standards-compliant test signer)
