---
description: Register an SSH host for ladvin agents
argument-hint: <ssh-alias> [observer|worker|yolo]
---
Call the `ladvin_add_host` MCP tool with `alias` set to the first word of "$ARGUMENTS" and, if a second word is given, `max_preset` set to it. Show the tool's output to the user verbatim. If it failed, point out the exact fix it names.
