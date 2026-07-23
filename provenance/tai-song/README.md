# Tai Song archive provenance

This directory contains the fixed inventory, sanitized author-master snapshots, integrity manifest, and human review checklist for the 11-article Tai Song archive.

Proton Docs HTML exports are the authority for current article content and hero presentation. Historical Vocal URLs and publication metadata are retained separately as public publication history. Raw Proton exports and all private document references remain ignored under `.proton-import/`.

Human review is recorded separately in the structured [`ReviewSignoffV1` record](review-signoffs.json). Each entry binds the reviewed snapshot, generated Markdown, and hero-image hashes to the reviewed commit, Tai Song's reviewer identity, canonical UTC timestamp, and passed text/presentation decisions. The committed record remains empty until Tai Song completes all eleven comparisons; automated integrity never fills it in.

See the [archive import runbook](../../docs/tai-song-import.md) for capture, import, verification, and update procedures.
