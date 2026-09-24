# Android release

Holoboard's Android app is a [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start/) for
[holoboard.space](https://holoboard.space). It uses the live website and has no
separate frontend or relay. The Android package ID is `space.holoboard.app`.

## Prerequisites

- Node.js, npm, JDK 17 and an Android SDK with platform 36 and Build Tools
  36.1.0.
- A local copy of the release signing keystore. The configured path is
  `android/private/release.p12`, with alias `holoboard`. Keep the keystore and
  its password outside Git, and back them up securely. Future updates must use
  the same signing key.
- A Nostr browser signer for the publisher identity in `zapstore.yaml`.

The release certificate SHA-256 fingerprint is
`3D:65:11:57:D6:5A:C3:CA:CF:B2:D5:0A:3A:17:60:46:AC:FA:16:B3:56:8A:DD:69:D9:7D:FF:8F:29:A1:3E:F7`.
The website must serve [assetlinks.json](../web/public/.well-known/assetlinks.json)
at `https://holoboard.space/.well-known/assetlinks.json` for Android to verify
the app and open the Trusted Web Activity without a browser toolbar.

## Build and inspect

From `android/`:

```bash
npm ci
npm run build
```

The signed result is `android/app-release-signed.apk`. Do not place passwords
in scripts, shell history or the repository. Bubblewrap prompts for the signing
passwords, or a local secret manager can supply them through
`BUBBLEWRAP_KEYSTORE_PASSWORD` and `BUBBLEWRAP_KEY_PASSWORD`. Bubblewrap also
stores your JDK and Android SDK paths in a local configuration file and prompts
for them on first use. Check the APK before publishing:

```bash
apksigner verify --print-certs android/app-release-signed.apk
aapt dump badging android/app-release-signed.apk
```

Confirm package ID `space.holoboard.app`, the version name and code from
`android/twa-manifest.json`, and the fingerprint above. Install the APK on
Android with a browser that supports Trusted Web Activities, then check the
board, invoice promotion, preview and external wallet links. The verified
fullscreen experience requires the new `assetlinks.json` to be live first.

## Publish to Zapstore

The repository root contains `zapstore.yaml`. Its APK source is the locally
built signed APK. Screenshots in `android/store/screenshots/` are store assets;
update them when the UI changes.

Install [zsp v0.4.17](https://github.com/zapstore/zsp/releases/tag/v0.4.17),
which supports the browser signer used for this release. A prebuilt binary is
available for supported systems, or install it with Go 1.25:

```bash
go install github.com/zapstore/zsp@v0.4.17
```

Run from the repository root:

```bash
zsp publish --check zapstore.yaml
SIGN_WITH=browser zsp identity --link-key android/private/release.p12 --link-key-expiry 2y
SIGN_WITH=browser zsp publish zapstore.yaml
```

Run the identity command for the first release and renew the proof before it
expires. It links the Android signing certificate to the publisher
Nostr identity. Use the `holoboard` keystore above when `zsp` requests it and
check that the displayed npub matches `zapstore.yaml` before publishing the
proof. The publisher key is public; the Nostr signing key stays in the browser
signer. After publication, check the app listing and compare the downloaded
APK's SHA-256 hash with the signed local APK.

Get approval before pushing to `main`, deploying the website, or publishing
the Zapstore events. Deploy the website and verify its `assetlinks.json` before
publishing the APK. Record the release in `CHANGELOG.md` only after deployment
is confirmed.
