# Native client acceptance

Status: **not verified on a native device or simulator**. This checkout's macOS
development machine has neither Android `adb`/emulator tooling nor Xcode
`simctl`. No mobile toolchain was installed for this account preview. Desktop
browser checks and the server's separate HTTPS cookie jars do not establish
native session-storage compatibility.

The client package builds with ES2024 types and no DOM, React or server imports.
A JavaScript mobile application supplies an `AccountTransport`; Swift and Kotlin
applications can call the [same HTTP API](../../README.md#embedding-and-http)
directly. Neither approach runs Node.js, SQLite or the custody module on a phone.

## Transport and storage boundary

The transport owns an HTTPS cookie jar and handles every `Set-Cookie` header,
host/path scope, Secure, expiry and deletion. Persist its session credential in
platform-protected storage, such as Keychain or a Keystore-backed store, with an
explicit device backup policy. The account SDK does not persist credentials or
provide a verified platform adapter. A session ID returned in JSON is a
management identifier, not a credential.

Clients sharing one cookie jar must also share its auth-operation scope. Reuse
the same transport function or explicitly inject `createAccountAuthScope()`;
see the [client transport contract](../../docs/client.md). A transport promise
must settle after cookie writes finish or are definitively cancelled. A local
timeout alone does not establish that. Native background requests and process
restart need their own lifecycle handling before restoring a session.

Send the operator-configured allowed web `Origin` on mutations. This satisfies
the service's CSRF policy; it does not authenticate the application. Keep the
HTTPS trust store enabled and use operator-controlled HTTPS return links.
Registration and verification do not log the person in automatically. On app
restart, restore the cookie jar and call `getSession()` before asking the signer
for a public key. A 401, expired session or remote revocation clears active signer
state independently of any payment wallet.

## Required device evidence before activation

Record the device or simulator, OS, application framework, HTTP stack and protected
storage implementation alongside results for:

1. Register, follow verification and recovery return links, then log in through
   the configured origin policy.
2. Terminate and restart the application. Restore its protected cookie jar and
   sign an exact kind-1 event with the same public key.
3. Exercise cookie expiry and explicit logout, including all deletion cookies.
   Both must prevent further signing after another restart.
4. Reset the password from a second client. The first client must fail its next
   signing attempt; a fresh login must retain the original public key.
5. Reject a different account's identity and a late signature after logout or
   account switching. Keep exports out of automatic retries and telemetry.

This gate remains open. The local library and browser preview can be reviewed
without representing it as completed native acceptance.
