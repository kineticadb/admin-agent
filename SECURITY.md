# Security Policy

## Supported Versions

The Kinetica Admin Agent is in pre-1.0 development. Security fixes target the latest `0.x` release only. Once `1.0.0` ships, this policy will be updated to cover the active minor line.

| Version      | Supported           |
| ------------ | ------------------- |
| Latest `0.x` | Yes                 |
| Older `0.x`  | No — please upgrade |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email `security@kinetica.com` with:

- A description of the issue and the potential impact
- Steps to reproduce (minimal proof-of-concept is ideal)
- The affected version (output of `admin-agent --version` or the commit SHA)
- Your name or handle for acknowledgement, if you would like credit

We aim to acknowledge reports within **48 hours** and to have a patch in testing within **14 days** for critical issues.

As a backstop, you may also submit a private report through GitHub's [Security Advisories](https://github.com/kineticadb/admin-agent/security/advisories/new) flow.

## Responsible Disclosure

We ask that you give us **90 days** from initial report to publish a fix before public disclosure. For issues under active exploitation we will work with you on an accelerated timeline.

## Scope

### In scope

- Credential handling — Kinetica user/pass, Anthropic API key, OAuth tokens
- The mutation-tool approval gate and its bypass paths
- Prompt injection via untrusted data sources (database contents, table names, report text)
- Supply-chain concerns in this repository's build pipeline (dependencies, CI, release artifacts)
- Report-scrubbing completeness for saved diagnostic reports
- Downgrade attacks on URL resolution (the HTTPS → HTTP fallback path)

### Out of scope

- Bugs in Kinetica itself — please file those with Kinetica support
- Bugs in the underlying Claude Agent SDK — file with Anthropic
- Issues requiring physical access to a user's machine or their pre-compromised Anthropic/Kinetica account
- Denial-of-service against the agent process itself (running a local CLI with hostile input you control)

## Non-goals

This tool is an **administrative diagnostic agent** that runs with admin-level Kinetica credentials and executes approved mutations. It is not designed to be:

- Run as a multi-tenant service
- Exposed to untrusted users
- Run with unattended approval of mutation tools

Deploying it outside those intended bounds is not a supported use case, and vulnerabilities that only surface in such deployments may be closed as out-of-scope.
