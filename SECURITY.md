# Security Policy

Forge Agent Gate is the open developer on-ramp for Forge Orbital's agent-decision proof layer. Please report suspected vulnerabilities privately so they can be triaged before public disclosure.

## Supported Versions

Security fixes target the latest published npm version of `forge-agent-gate` and the `main` branch of this repository.

## Reporting a Vulnerability

Email security reports to security@forgeorbital.com.

Please include:

- the affected package version or commit
- a short reproduction path
- expected vs. observed behavior
- any logs, payloads, or screenshots that help us reproduce the issue
- whether the issue may affect API keys, proof-trail integrity, mandate enforcement, or MCP server behavior

Do not include live customer secrets, private keys, production credentials, or third-party data in a report. Use synthetic examples where possible.

## Response

We will acknowledge credible reports, investigate impact, and coordinate remediation. If a report affects the npm package, the preferred fix path is a new signed release through GitHub Actions trusted publishing.

## Scope Notes

Forge Agent Gate is a local risk-control gateway and MCP server. It is not a broker, custodian, or trading-advice system. Reports about financial performance, market outcomes, or third-party venue behavior are outside the security scope unless they expose a concrete vulnerability in this package.
