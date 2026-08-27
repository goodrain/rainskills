# App Assistant routing

Use this reference for static ownership decisions before touching Rainbond.

This is the default top-level owner for generic current-project deployment, inspection, and repair requests; the request should start here even when a lower-level phase is selected later.

## Exclusive deployment routes

1. Stay in rainbond-app-assistant for the current/local project, source code, a source directory or source package, an ordinary user-supplied bare Git repository URL, a private-image project, or an application name that is not identified as a third-party open-source suite. Current/local project signals take priority even when the project name matches a known suite.
2. Route to rainbond-opensource-app-deploy when the user supplies a third-party Docker Compose file/content, Helm chart/values, or container image-set descriptor, or explicitly asks to deploy a named third-party open-source suite such as Harbor, Dify, or n8n. An explicit upstream-suite intent may include its official Git URL; an ordinary bare Git deployment request remains source input for App Assistant.
3. Route to rainbond-template-installer when a Rainbond local/cloud market template is confirmed.

Do not query a market merely to avoid owning an unclassified application name. Do not browse an ordinary bare Git repository to change its route; the explicit current/local/source versus third-party-suite intent decides ownership.

After this static choice, load only the selected Skill's Runtime Gate. Never read a neighboring Skill's Runtime Gate.
