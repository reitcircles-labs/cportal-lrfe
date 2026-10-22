# Jira conventions

Site reitcircles.atlassian.net, project **API**, cloud id `5544e2a2-46b2-4fa7-856f-de7ac90ba371`.
Transitions: **11** In Progress, **21** Done. Tools: the `mcp__claude_ai_Atlassian__*` MCP tools.

## Keep the answers small

Jira answers carry avatars, full descriptions and every comment unless asked otherwise. Ask only for
what is needed, for example `getJiraIssue` with `fields: ["summary","status"]` and
`responseFields: ["fields.summary","fields.status.name"]`; read the description only when the work
needs it. Creating and transitioning return the whole issue: don't echo it back to the user.

## Per ticket

- **Start:** transition 11; read "Agreed design" and "Done when" comments, not the whole history.
- **Before closing:**
  1. "What changed" (commit hash, branch, not pushed) and "Test results" comments, in markdown;
  2. for UI or e2e work, the screenshots embedded in one captioned comment (below), never only local
     files: "otherwise there is no proof of you having done any frontend test";
  3. transition 21.
- **Style:** plain English, short bullets with bold lead-ins, no internal jargon; say what is still
  open and whose decision it is. A ticket whose "Done when" needs the user's agreement (targets, legal
  standing) stays In Progress with that stated.
- **New tickets:** as children of their epic (`parent`), with Why / What changes / Done when, and
  "Not in this ticket" to fence the scope.

## Screenshots in a comment

1. `executeWrite` with name `uploadAttachmentToJiraIssue`, inputs `{issueIdOrKey, filePath}` → an
   upload command with a short-lived token (about 20 min).
2. The token covers the whole media collection: one token can upload every file of a run, each with
   its own `name=` and `--data-binary @file`; take `data.id` from each answer.
3. One `addOrEditJiraIssueComment`, `contentFormat: "html"`, a caption per picture and
   `<figure data-type="media-single"><div data-type="media" data-id="<id>"
   data-collection="upload-user-collection--1796169761" data-media-type="file"></div></figure>`.

Never print or store the token beyond the upload.
