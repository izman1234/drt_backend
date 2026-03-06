# Contributing to DRT Backend

Thank you for your interest in contributing! This document outlines the rules and guidelines for contributing to the DRT Backend.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies with `npm install`
4. Create a new branch for your work (`git checkout -b your-feature`)
5. Make your changes
6. Test thoroughly before submitting

## Rules

- When contributing to this project, you must agree that you have the necessary rights to the content and that the content is being owned by the project's creator and can be used in any way.
- AI usage and code is acceptable, but proof that you understand the changepoints and have thourghly tested it must be given.

### Commits

- Write clear, descriptive commit messages
- Reference issue numbers where applicable (e.g., `Fix #42`)

### Pull Requests

- Provide a clear description of what the PR does and why
- Test your changes against the frontend client before submitting and describe testing done in description
- Keep PRs focused — avoid combining unrelated changes
- Ensure no new errors or warnings are introduced
- Update the README if your change affects setup, configuration, or API endpoints

### Security

- **Never** commit secrets, API keys, or private keys
- Do not weaken or bypass authentication, encryption, or rate limiting without discussion
- Report security vulnerabilities privately rather than in public issues (but feel free to fix them when spotted)
- All new auth-related code must follow the existing Ed25519 challenge-response pattern
- Database fields containing user content must use the existing AES-256-GCM encryption layer

### Database Changes

- All schema changes must include migration logic or be backwards-compatible
- Add new tables/columns via the existing `initializeDatabase()` pattern
- Never drop tables or columns without a migration path

### API Changes

- New endpoints must require JWT authentication unless there is a specific reason not to
- Follow the existing route structure (`routes/<resource>.js`)
- Validate all input — never trust client data
- Return consistent JSON response shapes
- Document new endpoints in the README

### Dependencies

- Minimize new dependencies — prefer Node.js built-ins where possible
- Justify any new dependency in your PR description
- Check for known vulnerabilities before adding packages

## Reporting Issues

- Use the issue tracker to report bugs or request features
- Include steps to reproduce for bug reports
- Include your Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the license associated with this project (see [LICENSE](LICENSE) for details).
