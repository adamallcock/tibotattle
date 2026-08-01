---
title: TiboTattle Visual Identity Brief
date: 2026-08-01
type: design-brief
status: open
---

# TiboTattle — app icon & identity brief

Hand this to an image-generation agent or designer. Everything below is a
constraint or a steer; the "Concepts" section is where the creative latitude
is.

## What the product is

A free, privacy-first macOS menu-bar/desktop app for developers. It reads the
usage logs that OpenAI's Codex already writes on your own Mac, works out what
that usage would have cost at public API prices, and compares it to how much
of your subscription quota actually got consumed. Everything stays local.

**The joke in the name:** "Tibo" is Thibault Sottiaux, OpenAI's Codex lead,
who developers affectionately meme about as the person who resets their usage
limits ("Saint Tibo, giver of tokens"). "Tattle" = the app tells on your
tokens. The tagline is **"Your tokens tattle — only to you."**

So the personality is: **cheeky, warm, insider-y, developer-humour** — a wink,
not a corporate dashboard. It should feel like something a developer would
screenshot and post. But it must not feel *mean* or surveillance-y: the whole
product promise is privacy, so nothing sinister, no eyes, no spy motifs, no
magnifying glass, no CCTV, no shushing-finger.

**It must not depict, caricature, or resemble any real person.** No faces of
identifiable humans, no saints/halos referencing a real individual.

## Deliverable

- **One primary square app icon**, designed for macOS (Big Sur onward).
- Delivered at **1024×1024 PNG, transparent background outside the icon
  shape**, plus the flat source if available (SVG strongly preferred).
- The artwork should sit on the standard macOS **rounded-square (squircle)**
  plate with roughly 10% margin on each side — i.e. the plate occupies about
  the central 80% of the canvas — with a soft drop shadow below it.
- Optional bonus: a **monochrome single-colour glyph** version (one flat
  shape, no gradients) for a 16×16 menu-bar template icon.

## Hard constraints

1. **Legible at 32×32 and recognisable at 16×16.** This is the single most
   important test. One dominant shape, high contrast, no fine detail, no thin
   strokes, no text inside the icon.
2. **No lettering or numerals** in the icon (no "TT", no "$", no "%").
3. Flat / semi-flat vector styling. Subtle depth is fine (a soft inner sheen,
   a gentle shadow). **Avoid**: heavy skeuomorphism, glassy 2010-era gloss,
   bevels, neon glow, gradient-mesh blobs, drop-shadowed text, AI-slop
   iridescence, or busy backgrounds.
4. **Avoid the generic AI/analytics clichés**: no brain, no robot, no circuit
   board, no sparkles/✨ motif, no generic pie chart, no gauge/speedometer,
   no rocket, no magnifying glass.
5. Must read distinctly from Little Snitch, CleanMyMac, Activity Monitor, and
   any OpenAI/Anthropic first-party marks. No OpenAI logo or lookalike.

## Palette

Anchor to the app's existing UI so the icon and dashboard feel like one
product:

| Role | Hex | Notes |
| --- | --- | --- |
| Deep green (primary) | `#1D3A2C` | Current plate colour; confident, calm |
| Cream (primary contrast) | `#F4EFE3` | The app's background/paper tone |
| Amber (accent) | `#EDB33F` | Use sparingly — one small "tell" element |

Either polarity works: cream mark on a green plate, or a green mark on a
cream plate. Feel free to propose one alternative palette if you think the
personality calls for something warmer, but include a version in the above
colours.

## Concepts — pick one and develop it (in rough order of preference)

**1. The little bird (strongest idea).**
"A little bird told me" is the exact idiom for tattling. A small, charming,
minimal bird — chunky and friendly, not a realistic sparrow — leaning
forward mid-whisper. Ideas worth trying: its **tail feathers form three
ascending bars** like a bar chart; or it perches on a bar-chart baseline; or
a tiny amber beak is the only accent colour. Should feel like a confident
mascot that could later be animated or stickered. Avoid: Twitter-bird
silhouette, angry birds, anything hawk-like.

**2. The tattling speech bubble.**
A bold speech bubble as the dominant shape with a **miniature ascending
bar chart inside it**, and a tail pointing down-left. The bubble does the
"telling", the bars do the "usage". Strongest at tiny sizes; the safest
option. Push it further than the obvious: e.g. the bubble's tail could itself
be a bar, or the bars could overflow the bubble slightly.

**3. Whisper / cupped hand.**
An abstract whisper: two or three curved "sound" arcs emanating from a simple
form, with the arcs stepping up in height so they double as a rising chart.
Very clean, very small-size friendly, less literal than the bird.

**4. Wildcard — surprise us.**
Any mark that lands "cheeky insider tool that tells you the truth about your
usage". If it makes a developer smile in a menu bar, it's right.

## Tone reference points

Think: **Raycast, Linear, Arc, Bear, Things** — modern indie-Mac craft, high
contrast, one clear idea. Not: enterprise SaaS, crypto, gaming, cyberpunk.

## What we'll do with it

The winning mark becomes the macOS app icon (`AppIcon.icns`), the favicon and
social preview for the site, and the in-app brand glyph beside the wordmark
"TiboTattle" (currently three ascending bars — expect to replace it so the
system is coherent).

Note: the product may be renamed later (e.g. "TokenTattle"), so **the mark
should work with any "…Tattle" name** and should not embed the letters "Ti"
or a Tibo-specific likeness.

## Suggested prompt seed for an image model

> A minimal, modern macOS app icon on a rounded-square deep-green (#1D3A2C)
> plate with a soft shadow. Centred: a small, chunky, friendly cream (#F4EFE3)
> bird leaning forward as if whispering a secret, its tail feathers forming
> three ascending bar-chart bars, with a tiny amber (#EDB33F) beak. Flat
> vector illustration, bold simple shapes, high contrast, no text, no
> gradients beyond a subtle sheen, designed to stay legible at 32 pixels.
> Indie Mac app aesthetic in the spirit of Raycast and Linear.

Ask for 4–6 variations, then a refinement pass on the best one at 1024×1024.
