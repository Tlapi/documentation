# Mintlify Starter Kit

Use the starter kit to get your docs deployed and ready to customize.

Click the green **Use this template** button at the top of this repo to copy the Mintlify starter kit. The starter kit contains examples with

- Guide pages
- Navigation
- Customizations
- API reference pages
- Use of popular components

**[Follow the full quickstart guide](https://starter.mintlify.com/quickstart)**

## AI-assisted writing

Set up your AI coding tool to work with Mintlify:

```bash
npx skills add https://mintlify.com/docs
```

This command installs Mintlify's documentation skill for your configured AI tools like Claude Code, Cursor, Windsurf, and others. The skill includes component reference, writing standards, and workflow guidance.

See the [AI tools guides](/ai-tools) for tool-specific setup.

## Development

Install the [Mintlify CLI](https://www.npmjs.com/package/mint) to preview your documentation changes locally. To install, use the following command:

```
npm i -g mint
```

Run the following command at the root of your documentation, where your `docs.json` is located:

```
mint dev
```

View your local preview at `http://localhost:3000`.

## API reference (OpenAPI spec)

`openapi.json` is **generated** from the MDX files under `api-reference/` — it is the source of truth for the OpenAPI 3.1 spec, but it is not edited by hand.

The generator and its tests run on **Node.js (20 or newer)** with no extra dependencies. If you don't have Node installed, get it from [nodejs.org](https://nodejs.org/) (or via a version manager like [nvm](https://github.com/nvm-sh/nvm)); check with `node --version`.

Whenever you change anything in an `api-reference/*.mdx` endpoint file (frontmatter `api:`/`title`/`description`, `<ParamField>`, `<RequestExample>`, or `<ResponseExample>`), regenerate the spec and commit it together with your MDX change:

```bash
node scripts/generate-openapi.mjs
```

This rewrites `openapi.json` in place. To verify nothing else drifted, the regenerated file should diff cleanly against what's committed:

```bash
node scripts/generate-openapi.mjs --out /tmp/openapi.json && diff openapi.json /tmp/openapi.json
```

To sanity-check your changes end to end, import the regenerated `openapi.json` into Postman (**Import** → select the file) and confirm the affected endpoints — paths, parameters, request body, and examples — look the way you expect.

The generator has a test suite (fixtures under `scripts/__fixtures__/`, no dependencies) that asserts an MDX edit produces exactly the expected change in the spec. Run it after touching `scripts/generate-openapi.mjs`:

```bash
node --test scripts/generate-openapi.test.mjs
```

Notes:
- The generator only includes endpoints listed in the `API reference` tab of `docs.json`. A new endpoint MDX must be added to `docs.json` navigation, otherwise it is silently omitted from both the docs and the spec.
- Use a consistent path-parameter name for the same resource across files (e.g. always `{id}` or always `{template_id}`) — mismatched names produce an invalid spec (duplicate paths).
- **Production serves `openapi.json` directly from the docs site at `/openapi.json`** (the download links in `index.mdx` and `api-reference/introduction.mdx` point there). It is deployed together with the rest of the docs on push to the default branch — no separate CDN, branch pinning, or cache purge to manage.

## Publishing changes

Install our GitHub app from your [dashboard](https://dashboard.mintlify.com/settings/organization/github-app) to propagate changes from your repo to your deployment. Changes are deployed to production automatically after pushing to the default branch.

## Need help?

### Troubleshooting

- If your dev environment isn't running: Run `mint update` to ensure you have the most recent version of the CLI.
- If a page loads as a 404: Make sure you are running in a folder with a valid `docs.json`.

### Resources
- [Mintlify documentation](https://mintlify.com/docs)
