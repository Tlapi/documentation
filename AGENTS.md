# Documentation project instructions

## About this project

- This is the API documentation site for [Ecomail](https://ecomail.app) built on [Mintlify](https://mintlify.com)
- Ecomail is an email marketing platform available at ecomail.cz, ecomail.pl, and ecomail.app
- The API base URL is `https://api2.ecomailapp.cz/`
- Pages are MDX files with YAML frontmatter
- Configuration lives in `docs.json`
- Run `mint dev` to preview locally
- Run `mint broken-links` to check links

## API documentation conventions

- Each API resource gets its own directory under `api-reference/` (e.g., `api-reference/lists/`)
- Each endpoint is a separate MDX file using Mintlify's `api` frontmatter field
- Authentication is via `key` header (not Bearer token)
- Include `RequestExample` with at least cURL and PHP examples
- Include `ResponseExample` with realistic sample data
- Document all properties using `ParamField` components

## Terminology

- Use "list" not "mailing list" or "contact list"
- Use "subscriber" not "contact" or "user"
- Use "API key" not "token" or "secret"

## Style preferences

- Use active voice and second person ("you")
- Keep sentences concise — one idea per sentence
- Use sentence case for headings
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and code references
- All documentation is written in English

## Content boundaries

- Only document the public Ecomail API v2.0
- Do not document internal/admin endpoints
