# bounced.one

Landing page and frontend for Bounced — the shareable A/B comparison tool for music.

Hosted on GitHub Pages at [bounced.one](https://bounced.one).

## Structure

```
bounced-site/
├── index.html                              # Landing page + comp tool (HTML/CSS/JS)
├── CNAME                                   # Custom domain: bounced.one
├── favicon.png                             # 32x32 favicon
├── apple-touch-icon.png                    # 180x180 iOS icon
├── blog/
│   ├── index.html                          # Blog index
│   └── how-to-ab-compare-mixes-online.html # SEO blog post
├── audio/
│   ├── Look Away - Clean.mp3               # Demo audio
│   └── Look Away - Explicit.mp3            # Demo audio
└── assets/
    ├── logo.png                            # Full logo (icon + wordmark)
    ├── icon.png                            # Icon mark only (headphone)
    ├── icon-192.png                        # PWA icon
    └── icon-512.png                        # PWA icon large
```

## Email Collection

The signup form posts to a Cloudflare Worker at `https://api.bounced.one/subscribe`. Emails are sent via MailerSend from `comp@bounced.one`.

## Share Comp

The "Send Comp" feature emails a shareable link via the Worker endpoint `POST /send-comp`. Recipients open the comp at `bounced.one?comp=<token>`, which loads audio from the Worker's KV store.

## Analytics & Ads

All pages include:
- **GA4**: `G-HRGWWR2EC6` (Google Analytics)
- **Google Ads**: `AW-950920333` (conversion tracking)

Both are loaded via a single gtag.js snippet with two `gtag('config', ...)` calls.

## Backend

The Cloudflare Worker lives in `../worker/`. See `worker/wrangler.toml` for config.
