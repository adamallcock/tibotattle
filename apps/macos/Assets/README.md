# macOS release artwork gate

External-distribution builds require both reviewed files in this directory:

- `AppIcon.icns`
- `AppIcon.provenance.txt`

The current tracked icon and provenance were approved for distribution with the
initial stable release. Their presence does not pre-approve a replacement:
every build validates the pair, and any artwork change must update its truthful
rights/source record in the same reviewed change.

The provenance file is copied into the application licenses directory. It must
be UTF-8 text, must not contain placeholders, and must include:

```text
Source: where the approved source artwork came from
Rights: who owns it or who granted permission to distribute it
License: the applicable license or explicit distribution permission
```

Do not generate, download, replace, or infer an icon merely to make the release
command pass. Artwork approval, rights, and provenance remain per-change human
release gates; a passing asset check is not signing, notarization, packaging,
publication, or installed-artifact evidence.
