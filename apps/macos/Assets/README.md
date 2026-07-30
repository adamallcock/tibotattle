# macOS release artwork gate

External-distribution builds intentionally fail until both of these reviewed
files exist in this directory:

- `AppIcon.icns`
- `AppIcon.provenance.txt`

The provenance file is copied into the application licenses directory. It must
be UTF-8 text, must not contain placeholders, and must include:

```text
Source: where the approved source artwork came from
Rights: who owns it or who granted permission to distribute it
License: the applicable license or explicit distribution permission
```

Do not generate, download, or infer an icon merely to make the release command
pass. Artwork approval and provenance are human release gates.
