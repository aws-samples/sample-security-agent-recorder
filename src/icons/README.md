# Extension Icons

This directory holds the toolbar and management-page icon binaries referenced
by `src/manifest.json`. Producing the actual PNG files is out of scope for
this implementation plan; this README documents what the manifest expects so
the binaries can be dropped in later without touching code.

## Required files

The manifest references the following icon sizes for both `action.default_icon`
and the top-level `icons` block:

| File           | Pixel size | Used for                                         |
| -------------- | ---------- | ------------------------------------------------ |
| `icon-16.png`  | 16 × 16    | Toolbar action button at standard DPI            |
| `icon-32.png`  | 32 × 32    | Toolbar action button at high DPI / Windows menu |
| `icon-48.png`  | 48 × 48    | Extensions management page                       |
| `icon-128.png` | 128 × 128  | Chrome Web Store / installation dialogs          |

Each file must be a PNG with a transparent background and square dimensions
matching the size in its filename.

## Recording-state variant (optional)

The background service worker calls `browser.action.setIcon` to switch to a
visually distinct icon while a recording session is active (Requirement 2.9).
If a recording-state icon set is provided, place it alongside the default
files using a `-recording` suffix:

- `icon-16-recording.png`
- `icon-32-recording.png`
- `icon-48-recording.png`
- `icon-128-recording.png`

Until those files exist, the badge text (`REC`) and badge background color
provide the visual distinction on their own.
