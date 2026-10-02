# Security Policy

## Supported Versions

The following versions of Electric Guardian are currently receiving security updates:

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < Latest | :x:               |

We recommend always running the latest release. Older versions will not receive security patches.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, please report it responsibly:

1. **GitHub private vulnerability reporting**: open the repository's *Security* tab → *Report a vulnerability* (https://github.com/allysongrollimd-svg/eletric-guardian/security/advisories/new)
2. **Include**:
   - A description of the vulnerability
   - Steps to reproduce the issue
   - Affected components (e.g., HTTP server, MQTT, surveillance, camera, Telegram bot)
   - Potential impact
   - Any suggested fix (optional)

## Security Considerations

Given that Electric Guardian runs on vehicle hardware and handles sensitive data, the following areas are particularly security-sensitive:

- **HTTP/TCP/IPC servers** — Unauthorized access to API endpoints could expose vehicle data or camera feeds
- **MQTT messaging** — Improperly secured MQTT connections could leak telemetry data
- **Telegram bot integration** — Command injection or unauthorized access to the daemon bot
- **Surveillance & camera streams** — Unauthorized access to live or recorded video feeds
- **Vehicle data (BYD APIs)** — Exposure of vehicle diagnostics, location, or battery data
- **Remote access (Zrok)** — Tunnel misconfiguration could expose the device to the internet
- **OTA updates** — Tampered update packages could compromise the device
- **Cloud dashboard (`webapp/`)** — Holds GPS position and vehicle state; always run it behind HTTPS with a strong `DASHBOARD_TOKEN` and an authenticated MQTT broker

## Best Practices for Contributors

- Never commit API keys, tokens, or credentials to the repository
- Use parameterized queries and input validation in all API handlers
- Validate and sanitize all user input, especially in web UI and server endpoints
- Use HTTPS/TLS for all network communication where possible
- Follow the principle of least privilege for file and network access
- Log security-relevant events without exposing sensitive data in logs

## Disclosure Policy

We follow a coordinated disclosure process:

1. Reporter submits vulnerability privately
2. We confirm and assess the issue
3. We develop and test a fix
4. We release the fix and publish an advisory
5. Reporter is credited (if desired)

We ask that you give us reasonable time to address the issue before any public disclosure.

---

Thank you for helping keep Electric Guardian and its users safe.
