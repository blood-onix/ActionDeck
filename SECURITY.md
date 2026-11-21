# Security Policy

ActionDeck works with your GitHub account through VS Code's built-in GitHub sign-in, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include the steps to reproduce, the ActionDeck and VS Code versions, and what impact you expect.

You should get a reply within a week. Once a fix ships, the report can be disclosed publicly.

## Supported versions

Only the latest released version receives security fixes.

## How ActionDeck handles your access

- It signs in with VS Code's GitHub authentication provider. It never asks for pasted personal access tokens.
- It requests the `repo` scope only when you open a private repository, and only after you confirm.
- It never requests the `workflow` scope, so it cannot edit workflow files on GitHub.
- It can't read secret values. GitHub's API only returns secret names.
