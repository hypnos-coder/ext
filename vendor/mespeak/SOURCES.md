# Bundled offline speech

meSpeak.js 2.0.7 by Norbert Landsteiner, mass:werk (2011–2020),
incorporating the eSpeak synthesizer and the speak.js Emscripten port.
The engine and voice data are licensed under GNU GPL version 3;
see [LICENSE.txt](LICENSE.txt) for the unmodified upstream license.

All runtime files are bundled locally. No service receives reading text,
and no executable code or voice data is downloaded at runtime.

Upstream documentation and source archive:

- https://www.masswerk.at/mespeak/
- https://www.masswerk.at/mespeak/mespeak.zip
- https://github.com/kripken/speak.js (original port, C++ sources and build scripts)
- https://espeak.sourceforge.net/ (original speech synthesizer)

The archive used here has SHA-256:
`0f64d9659cff8551d16473b65fae6e02439292c249e0c2c76f602b16838e5156`.

Included runtime files are `mespeak.js`, `mespeak-core.js`, and
`voices/en/en-us.json`. `source/` preserves the upstream readable JavaScript
for the wrapper and generated engine. The minified core and voice data are
unmodified. The readable runtime wrapper has one marked Sona modification
(2026-10-11): resolve voice file paths with the standard `URL` constructor
to support the `chrome-extension:` scheme.

This is basic synthetic speech, intended to work on Linux Chrome even when
neither Chrome TTS nor the browser has any installed speech voices.
