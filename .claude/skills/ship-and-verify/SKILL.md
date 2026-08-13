---
name: ship-and-verify
description: Build, test, push, and confirm a live Railway redeploy of the Shopify MCP server, so changes are actually testable by the user right after they're made. Use whenever code in this repo is changed and the user expects to test it — after implementing a fix, before saying "done," or when asked to "make it live," "deploy," "push so I can test," or similar. Do not report a change complete without running this.
---

# Ship and verify

This repo has burned the user once already: changes were committed and pushed to a branch, but never reached the server they were actually testing against (a different branch, deployed to Railway, than the one being worked on). "Committed" is not "live." This skill closes that gap — every time.

## Why this exists

There can be more than one implementation of this server living in different branches (check `git branch -a` and `git log --oneline -5` on each candidate if unsure which one is "live"). The one that matters is whichever branch **Railway's `shopify-mcp` service actually tracks** — not `main`, not necessarily the branch you're on. Confirm the tracked branch before assuming a push will deploy anything:

```
mcp__Railway__get-service-config with projectId/environmentId/serviceId for the shopify-mcp-multiaccount project
```

Look at `config.source.branch`. That is the only branch a push to GitHub will actually redeploy.

## Steps, every time

1. **Typecheck and build locally.**
   ```bash
   npm run typecheck
   npm run build
   ```
   Stop and fix if either fails. Do not push code that doesn't build.

2. **Run the test suites.**
   ```bash
   node test/resilientClient.mjs   # transport: retries, throttling, timeouts, ACCESS_DENIED diagnosis
   node test/smoke.mjs             # MCP protocol: registration, multi-store targeting, error handling
   ```
   Both must show `PASS`. If a check fails, that's a real regression — fix it, don't skip it. If you added new behavior, add a check for it in one of these files rather than only eyeballing it once.

3. **Verify the HTTP transport still boots**, since that's what's actually deployed (not stdio):
   ```bash
   MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) PORT=8842 \
     SHOPIFY_STORES='[{"name":"x","domain":"x.myshopify.com","accessToken":"shpat_fake"}]' \
     node dist/index.js &
   sleep 1.5
   curl -s http://localhost:8842/health   # expect {"status":"ok"}
   kill %1
   ```

4. **Validate GraphQL documents against the live Shopify schema** (only if any `.ts` file with a `gql` query changed):
   ```bash
   npm run validate:graphql
   ```

5. **Commit with a real message** explaining what changed and why — not "fix stuff." Follow this repo's existing commit style (see `git log`): lead with what broke or what was missing, not just what the diff does.

6. **Push to the branch Railway tracks** (step 0's answer), not necessarily your current branch:
   ```bash
   # if working on a different local branch than the tracked one:
   git push origin <local-branch>:<railway-tracked-branch>
   # if already on the tracked branch:
   git push origin <railway-tracked-branch>
   ```

7. **Confirm Railway actually picked it up and deployed successfully** — do not assume push implies deploy:
   ```
   mcp__Railway__list-deployments (projectId, environmentId, serviceId, limit: 1)
   ```
   Check that the newest deployment's `commitHash` matches what you just pushed, and poll (a few seconds apart, not a long sleep) until `status` is `SUCCESS`. If it's `FAILED` or `CRASHED`, pull the build/deploy logs with `mcp__Railway__get-logs` and fix before telling the user anything is live.

8. **Smoke-test the live URL**, not just the local build — a local pass doesn't prove the deployed environment variables and config are correct:
   ```
   mcp__Railway__list-domains (projectId, environmentId, serviceId)
   curl -s https://<the-service-domain>/health   # expect {"status":"ok"}
   ```

9. **Tell the user plainly**: what changed, that it's live at the deployed URL, and how to reconnect/retest (e.g. "reconnect the `Shopify_MCP_Multi-account` connector, or just retry the same tool call — no client-side action needed since it's the same URL"). Never say "pushed" or "done" without having completed step 7 and 8 first.

## Do not skip steps to save time

Steps 1–4 catch regressions before they reach production. Steps 6–8 are what actually make the user's next test attempt correct instead of another wasted round-trip against stale code. Skipping the verification steps after pushing is exactly the mistake that prompted this skill to exist.
