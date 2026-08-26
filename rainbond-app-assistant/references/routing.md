# App Assistant routing

Use this reference for static ownership decisions before touching Rainbond.

This is the default top-level owner for generic current-project deployment, inspection, and repair requests; the request should start here even when a lower-level phase is selected later.

## Exclusive deployment routes

1. Stay in rainbond-app-assistant for the current project, source code, a source directory or source package, a user-supplied bare Git repository URL, a private-image project, or only an application name. A bare Git URL is source input, not a deployment descriptor.
2. Route to rainbond-opensource-app-deploy only when the user actually supplies a third-party Docker Compose file/content, Helm chart/values, or a container image-set descriptor.
3. Route to rainbond-template-installer when a Rainbond local/cloud market template is confirmed.

Do not query a market merely to avoid owning a descriptor-less named application. Do not clone or browse a bare Git repository to look for Compose/Helm files before routing: the explicit input boundary decides ownership.

After this static choice, load only the selected Skill's Runtime Gate. Never read a neighboring Skill's Runtime Gate.
