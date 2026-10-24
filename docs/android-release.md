# Android release

Holoboard's Android app is a [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start/)
for [holoboard.space](https://holoboard.space). It uses the live website and has
no separate frontend or relay. The package ID is `space.holoboard.app`.

Android **1.1.0**, version code **2**, accompanies the guided Add to board website
release. APK publication does not deploy the website. Email/password accounts
remain deferred.

## Prerequisites

- Node.js, npm, JDK 17 and Android SDK platform 36 with Build Tools 36.1.0.
  Set `JAVA_HOME` and `ANDROID_HOME` for the selected tools.
- Python 3 and Pillow for verifying the packaged brand assets.
- The existing release keystore at `android/private/release.p12`, alias
  `holoboard`. Keep it and its password outside Git and back them up securely.
- [zsp v0.4.17](https://github.com/zapstore/zsp/releases/tag/v0.4.17) and a Nostr
  browser signer for the publisher identity in `zapstore.yaml`.

The release certificate SHA-256 fingerprint is
`3D:65:11:57:D6:5A:C3:CA:CF:B2:D5:0A:3A:17:60:46:AC:FA:16:B3:56:8A:DD:69:D9:7D:FF:8F:29:A1:3E:F7`.
The website must serve [assetlinks.json](../web/public/.well-known/assetlinks.json)
at `https://holoboard.space/.well-known/assetlinks.json` for Android to verify
ownership and open fullscreen. Preserve the package ID and release signing key
for updates to existing installations.

## Prepare the sources

Keep `appVersionName`, `appVersionCode` and `appVersion` in
`android/twa-manifest.json` consistent with `android/app/build.gradle`. Increase
the code for each release. After manually updating the generated project, refresh
`android/manifest-checksum.txt` with the SHA-1 of `twa-manifest.json`. Otherwise
Bubblewrap may offer to regenerate the project from the deployed website.

The launcher, splash and store icons use the website's pink pixel H. After
changing `web/src/assets/holoboard-mark.svg`, regenerate them from the root:

```bash
python3 -B web/scripts/brand-assets.py --android
```

Keep the maskable safe area. A website deployment does not replace icons inside
an installed APK. Update the store description, versioned release notes and
screenshots referenced by `zapstore.yaml`. The [capture notes](../android/store/screenshots/README.md)
identify the controlled examples shown in the current screenshots.

## Build and sign

From `android/`:

```bash
npm ci
npm run build:unsigned
npm run sign
npm run check
```

The build produces `android/app-release-unsigned-aligned.apk`. Signing is a
separate interactive step: Android's `apksigner` prompts for the existing
keystore password on the terminal. Do not put passwords in commands, scripts,
shell history or the repository. The sign command verifies its candidate before
replacing `android/app-release-signed.apk`.

`npm run check` rejects an old APK, a different package/version or certificate,
invalid ZIP alignment, missing current launcher/splash images and release notes
for another version. `npm run check:unsigned` inspects a build without approving
its signature or publication. For independent inspection, use the SDK tools:

```bash
apksigner verify --print-certs android/app-release-signed.apk
aapt2 dump badging android/app-release-signed.apk
```

## Check the rollout

Deploy the compatible backend with guest-post admission before the website.
Verify the live site's features and Digital Asset Links. Install 1.1.0 over the
previous APK without clearing app or browser data. Check the new launcher/splash,
fullscreen launch, unfinished-invoice recovery, wallet and Amber handoff using
the [device checklist](../web/README.md#check-on-android-before-release).

An unsigned build or a temporary test certificate cannot establish update
compatibility with existing installations. A real payment still needs a
separately authorized budget.

## Publish to Zapstore

Install the pinned CLI from its release or with Go:

```bash
go install github.com/zapstore/zsp@v0.4.17
```

From `android/`, after signing and device checks:

```bash
npm run zapstore:check
npm run zapstore:publish
```

Both commands first verify the actual signed APK. The check command does not
publish. Publication uses `SIGN_WITH=browser`, so the existing Nostr browser
extension signs the Zapstore events. This is separate from the Android keystore
signature inside the APK. Inspect the publisher and intended version in the
browser before approving publication.

For a first release or an expired certificate proof, run from the root:

```bash
SIGN_WITH=browser zsp identity --link-key android/private/release.p12 --link-key-expiry 2y
```

This links the Android certificate to the Nostr publisher. Use the existing
keystore and check that the displayed npub matches `zapstore.yaml`. Keep the
Nostr signing key in the browser signer. After publication, compare the downloaded
APK's SHA-256 with the verified signed local APK and inspect the app listing.

Get approval before pushing to `main`, deploying the website or publishing
Zapstore events. Keep `CHANGELOG.md` entries under Unreleased until rollout is
confirmed. Never publish an APK signed with a temporary test key.
