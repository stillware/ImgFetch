# Security Policy

How to report an ImgFetch security vulnerability, which versions are supported, and what to expect after a report.

Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Supported versions

Only the newest code receives security fixes. Fixes are released in a new version. They are not backported to older versions.

| Version | Status | Supported |
|---|---|---|
| 1.1.0 | Current release, released 2026-10-22 | Yes |
| 1.0.0 | Previous release, released 2026-10-12 | No, upgrade to 1.1.0 is recommended |
| Older than 1.0.0 | Superseded | No |

## How to report a vulnerability

Report privately. Do not open a public issue, a public pull request, or a public discussion for a security vulnerability.

1. Open the repository: https://github.com/umr-x/ImgFetch
2. Open the **Security** tab.
3. Click **Report a vulnerability** (GitHub private vulnerability reporting).
4. Describe the problem using the list below.

There is no contact email address for security reports. GitHub private vulnerability reporting is the only private reporting channel.

## What to include

A report that can be reproduced is fixed faster. Include:

- The ImgFetch version (see Settings, About, or the extensions page).
- Your browser and its version (Google Chrome or Microsoft Edge), and your operating system.
- Step by step instructions to reproduce the problem.
- What you expected to happen and what happened instead.
- The impact you believe the problem has: what an attacker could read, change, or run, and under what conditions.
- A minimal proof of concept, a sample page, or a sample image file, if you have one.

## Response expectations

ImgFetch is maintained on a best effort basis. There is no response time guarantee and no service level agreement.

In practice, the maintainers aim to read every report, confirm whether it reproduces, and fix confirmed problems in a later release. You may be asked follow up questions through the private report thread. If a report is confirmed, the reporter is credited in the release notes unless they ask not to be.

## Scope

In scope:

- The extension code in this repository: the service worker, content scripts, the offscreen document, the popup, the Settings page, and the extension pages.
- Handling of untrusted web content: image URLs, SVG files, page content scanned by the extension, and downloads started by the user.
- The message protocol between extension pages, content scripts, and the offscreen document.
- Storage of settings, download history, and captures on the device.

Out of scope:

- Vulnerabilities in Google Chrome, Microsoft Edge, or another browser. Report those to the browser vendor.
- Malicious or compromised extensions other than ImgFetch, and problems that require one to be installed.
- Attacks that require physical access to an unlocked device, or control of the user account on that device.
- A website serving content the user chose to download. ImgFetch does not decide whether content is legal or safe to reuse. See [TERMS.md](TERMS.md).
- Social engineering, phishing, and denial of service attacks against GitHub or store infrastructure.
- Reports based only on automated scanner output, with no demonstrated impact on ImgFetch.

## Safe harbour

Good faith security research is welcome. If you make a genuine effort to follow this policy, avoid privacy violations and service disruption, and report what you find privately before disclosing it, the maintainers will not pursue a claim against you for that research and will treat the report as authorized.

## Technical details

The threat model, trust boundaries, mitigations, and accepted risks are documented in [docs/security-model.md](docs/security-model.md). The permissions the extension requests, and why each one is needed, are listed in [docs/permissions.md](docs/permissions.md).
