# License notices

Cukup's source is licensed under the [MIT License](LICENSE).

## Service image

The service image includes bundled `jose@6.1.0` code (MIT, copyright 2018 Filip Skokan).
The image contains the full Cukup and `jose` notices at `/app/licenses/Cukup.txt`
and `/app/licenses/jose.txt`.

## Amp Plugin API types

Cukup uses `@ampcode/plugin@0.0.0-20260830001921-g9741aa9` as a development-only
TypeScript dependency. Cukup imports only types. The built plugin and the
service image do not include this package.

The [npm package metadata](https://registry.npmjs.org/@ampcode%2fplugin) labels
the package “Amp Commercial License.” The
[locked version's registry record](https://registry.npmjs.org/@ampcode%2fplugin/0.0.0-20260830001921-g9741aa9)
does not specify a license. Its tarball matches the integrity hash in `bun.lock`
and has no license file or `license` field in `package.json`.

These records do not establish the terms for the locked version or show that
Cukup cannot publish its own MIT-licensed source. Cukup's MIT license does not
cover the Amp package. Ask Amp to confirm the terms for public development and
CI use, and do not redistribute the Amp package without confirmed permission.
