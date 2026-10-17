# Setup for agents

Use this guide when asked to install or configure SMS CLI. Use the local route for development-only requests and the live route for an operational inbox. [README.md](../README.md) documents the commands and failure handling; [.env.example](../.env.example) defines the installation settings.

## Prepare the checkout

1. Run commands from the repository root. Inspect the working tree and preserve existing changes.
2. Use the Node version in `.nvmrc`, then run `npm ci` and `npm run check`. These checks need no service credentials.
3. Create `.env` from `.env.example` only if `.env` is absent. On macOS or Linux:

   ```sh
   if [ ! -e .env ]; then
     (umask 077 && cp .env.example .env)
   fi
   chmod 600 .env
   ```

4. Check which required values are present without printing their contents. Preserve configured values. Commands load `.env` from the working directory; process environment variables take precedence. `.env.local` is not loaded. Check for stale environment overrides when a command uses an unexpected account or database.

Keep secrets in `.env`, an authorized secret manager, or the process environment. Capture token-generating CLI output through a subprocess pipe and save it directly to configuration. Keep tokens out of tool output, command arguments, chat, and committed files. Ask the user to enter unavailable credentials locally rather than paste them into chat. Parse `.env` with `dotenv`; do not execute it as shell code.

## Local development

For a fresh local installation, keep `TURSO_DATABASE_URL=file:local.db` and leave `TURSO_AUTH_TOKEN` blank. If this checkout already uses a remote database, use an explicit environment override for these commands rather than replacing its configuration:

```sh
TURSO_DATABASE_URL=file:local.db TURSO_AUTH_TOKEN= npm run db:migrate
TURSO_DATABASE_URL=file:local.db TURSO_AUTH_TOKEN= npm run --silent sms -- inbox --json
```

Local setup is complete when the schema initializes, inbox returns a JSON array, and `npm run check` passes. Twilio credentials and a deployed webhook are unnecessary for this route. This verifies local storage and the CLI; receiving real messages requires the live route.

## Live installation

### Select services and configure credentials

1. Identify the user's intended Twilio account and SMS-capable number, Turso database, and Vercel project and scope. Reuse resources selected for this installation. Resolve ambiguous account or number choices before changing remote settings. Purchasing a number or selecting a paid plan requires the user's instruction.
2. Check for the Turso and Vercel CLIs and their authenticated account contexts. Use each CLI's `--help` for installed-version syntax. Complete supported CLI authentication flows; involve the user only for login, account access, or other steps requiring their action. The supplied Twilio scripts run its official CLI through `npx`.
3. Fill the runtime settings in `.env` using the variable descriptions in README. The Twilio auth token must belong to the configured account and number. Use a remote database URL for production. Local file databases cannot serve as shared Vercel storage.
4. If provisioning a database is part of the request, use the Turso commands under README's Database section with the chosen database name and optional group. Capture its URL and database token into `.env`. Use a token that permits schema creation and message writes.
5. Run `npm run db:migrate` against the configured remote database. Finish this step only when schema initialization succeeds.

### Deploy the webhooks

1. Set `VERCEL_PROJECT_NAME` and, when needed, `VERCEL_SCOPE` in `.env`. To reuse an existing link with both values omitted, inspect `.vercel/project.json` and verify that it belongs to this installation before uploading credentials.
2. Inspect or create the intended project with the Vercel CLI. Set `WEBHOOK_BASE_URL` to its intended stable HTTPS production origin. Use an origin without a path, query, credentials, or trailing slash.
3. Run `npm run deploy`. This uploads the configured runtime values and deploys production. Check the resulting production alias against `WEBHOOK_BASE_URL`. If a new project's assigned alias differs, update `.env` and deploy again before connecting Twilio. Keep production credentials in the production environment.
4. Check both public endpoints with unsigned form POSTs. This probe reads the configured origin and never sends an SMS:

   ```sh
   node --import tsx --import dotenv/config --input-type=module <<'JS'
   import { webhookOrigin } from './src/config.ts';

   for (const kind of ['inbound', 'status']) {
     const response = await fetch(`${webhookOrigin()}/api/twilio/${kind}`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
       body: '',
       redirect: 'manual',
     });
     if (response.status !== 403) {
       throw new Error(`${kind}: expected 403, received ${response.status}`);
     }
     console.log(`${kind}: unsigned request rejected`);
   }
   JS
   ```

   Both endpoints must return `403`. A redirect, login page, or `503` leaves deployment unverified. Check production access protection, deployed credentials, and function logs. Keep signature validation enabled and avoid logging credentials or SMS bodies while diagnosing failures.

### Connect the number and verify receipt

1. Run `npm run twilio:number`. Verify that the returned account-owned number is the selected number, and inspect its current SMS routing. If a TwiML application, Messaging Service, or another service controls routing, resolve that integration before replacing it.
2. When connecting the selected number is within the requested setup scope, run `npm run twilio:connect`. It checks webhook readiness, saves the previous SMS settings under `.local/`, and updates the number's SMS URL and method. Retain the backup path. Resolve a conflicting existing integration with the user before replacing it.
3. Run `npm run --silent sms -- inbox --json` to verify remote database access. Report only the count or verification result when message contents are unnecessary.
4. To verify actual receipt, have the user send a recognizable test text from their phone to the configured Twilio number, then check inbox for that message. Until then, report routing as configured and actual receipt as unverified.
5. An outgoing test requires the user's authorization for its recipient and body. Use a unique `--request-id` for the logical message and reuse it for retries. For an uncertain result, follow README's reconciliation instructions before attempting another send.

## Report completion

State which route completed, which checks passed, and whether real inbound or outbound delivery was tested. For live setup, include the configured number, stable webhook origin, and any routing backup path when useful to the user. Keep credentials and unrelated message contents out of the report.

If a step is blocked, finish independent local work and identify the specific missing credential, login action, account choice, or routing decision. A passing local test suite alone does not verify a live installation.
